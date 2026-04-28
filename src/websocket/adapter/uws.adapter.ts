import { WebSocketAdapter, Logger } from '@nestjs/common';
import { MessageMappingProperties } from '@nestjs/websockets';
import { Observable } from 'rxjs';
import * as uWS from 'uWebSockets.js';
import { randomBytes } from 'crypto';
import { ModuleRef as NestModuleRef } from '@nestjs/core';
import type {
  UwsAdapterOptions,
  ResolvedUwsAdapterOptions,
} from '../interfaces/uws-options.interface';
import type { WebSocketClient } from '../interfaces/websocket-client.interface';
import { MetadataScanner } from '../routing/metadata-scanner';
import { MessageRouter } from '../routing/message-router';
import { HandlerExecutor } from '../routing/handler-executor';
import { RoomManager } from '../rooms/room-manager';
import { UwsSocketImpl } from '../core/socket';
import { LifecycleHooksManager } from './lifecycle-hooks';
import { NestJsModuleRef, type ModuleRef } from '../../shared/di';

/**
 * Extended WebSocket with client data
 */
interface ExtendedWebSocket extends uWS.WebSocket<WebSocketClient> {
  id?: string;
}

/**
 * High-performance WebSocket adapter using uWebSockets.js
 *
 * IMPORTANT: This adapter requires manual gateway registration using registerGateway().
 * Unlike standard NestJS WebSocket adapters, bindMessageHandlers() is not used.
 * This design choice provides better control over metadata scanning and handler registration.
 *
 * Supports multiple gateways - you can register multiple gateway classes, and each will
 * have its handlers registered independently. This allows you to organize your WebSocket
 * handlers into logical groups.
 *
 * Supports dependency injection for guards, pipes, and filters when a ModuleRef is provided.
 * Pass a ModuleRef to enable guards/pipes/filters with constructor dependencies.
 *
 * @example
 * ```typescript
 * // Basic setup with single gateway
 * const app = await NestFactory.create(AppModule);
 * const adapter = new UwsAdapter(app, { port: 8099 });
 * app.useWebSocketAdapter(adapter);
 *
 * // Manually register your gateway
 * const gateway = app.get(EventsGateway);
 * adapter.registerGateway(gateway);
 *
 * await app.listen(3000);
 * ```
 *
 * @example
 * ```typescript
 * // Multiple gateways for organized handlers
 * const app = await NestFactory.create(AppModule);
 * const adapter = new UwsAdapter(app, { port: 8099 });
 * app.useWebSocketAdapter(adapter);
 *
 * // Register multiple gateways
 * const chatGateway = app.get(ChatGateway);
 * const gameGateway = app.get(GameGateway);
 * const notificationGateway = app.get(NotificationGateway);
 *
 * adapter.registerGateway(chatGateway);
 * adapter.registerGateway(gameGateway);
 * adapter.registerGateway(notificationGateway);
 *
 * await app.listen(3000);
 * ```
 *
 * @example
 * ```typescript
 * // With DI support (guards/pipes/filters can have constructor dependencies)
 * const app = await NestFactory.create(AppModule);
 * const moduleRef = app.get(ModuleRef); // Get NestJS ModuleRef
 * const adapter = new UwsAdapter(app, {
 *   port: 8099,
 *   moduleRef, // Enable DI for guards/pipes/filters
 * });
 * app.useWebSocketAdapter(adapter);
 *
 * // Register your gateways
 * const gateway = app.get(EventsGateway);
 * adapter.registerGateway(gateway);
 *
 * await app.listen(3000);
 * ```
 */
export class UwsAdapter implements WebSocketAdapter {
  private app!: uWS.TemplatedApp;
  private isSharedApp = false;
  private listenSocket: false | uWS.us_listen_socket = false;
  private clients = new Map<string, ExtendedWebSocket>();
  private sockets = new Map<string, UwsSocketImpl>(); // Track wrapped sockets
  private readonly logger = new Logger(UwsAdapter.name);
  private readonly options: ResolvedUwsAdapterOptions;
  private wsHandler?: {
    handleConnection: (ws: ExtendedWebSocket) => void;
    handleMessage: (ws: ExtendedWebSocket, data: string) => void;
    handleDisconnect: (ws: ExtendedWebSocket) => void;
  };

  // Router components
  private readonly metadataScanner = new MetadataScanner();
  private readonly messageRouter = new MessageRouter();
  private readonly handlerExecutor: HandlerExecutor;
  private readonly roomManager = new RoomManager();
  private readonly lifecycleHooksManager = new LifecycleHooksManager();
  private readonly gateways = new Map<object, string>(); // key=gateway instance, value=name
  private gatewaySet = new WeakSet<object>(); // Track registered instances
  private bindMessageHandlersCalled = false;

  constructor(appInstance: unknown, options?: UwsAdapterOptions) {
    // Note: appInstance is required by NestJS WebSocketAdapter interface but not used
    // in this implementation. NestJS passes the app instance for adapters that need
    // access to the application context, but UwsAdapter uses explicit gateway registration
    // via registerGateway() instead.

    // Apply default options
    // Note: port will be set in create() using NestJS-provided port as fallback
    this.options = {
      maxPayloadLength: options?.maxPayloadLength ?? 16 * 1024,
      idleTimeout: options?.idleTimeout ?? 60,
      maxLifetime: options?.maxLifetime ?? 0, // 0 = disabled (no lifetime limit)
      compression: options?.compression ?? uWS.SHARED_COMPRESSOR,
      port: options?.port ?? 8099, // Default to 8099 if not provided
      path: options?.path ?? '/*',
      maxBackpressure: options?.maxBackpressure ?? 1024 * 1024, // 1MB default
      closeOnBackpressureLimit: options?.closeOnBackpressureLimit ?? false,
      sendPingsAutomatically: options?.sendPingsAutomatically ?? true,
      cors: options?.cors,
      // SSL/TLS fields - carried through as-is (undefined when not supplied)
      cert_file_name: options?.cert_file_name,
      key_file_name: options?.key_file_name,
      passphrase: options?.passphrase,
      dh_params_file_name: options?.dh_params_file_name,
      ssl_prefer_low_memory_usage: options?.ssl_prefer_low_memory_usage,
    };

    // Use provided uWS App if available (v2.0.0+ for HTTP + WebSocket integration)
    if (options?.uwsApp) {
      this.app = options.uwsApp;
      this.isSharedApp = true;
      this.logger.log('UwsAdapter using provided uWS App instance (shared with HTTP)');

      // Warn if port is also specified (it will be ignored in shared mode)
      if (options?.port) {
        this.logger.warn(
          'Both uwsApp and port options provided. Port option is ignored when using shared app - ' +
            'the HTTP server manages the listening port.'
        );
      }

      // Warn if SSL options are also specified (TLS is controlled by the shared app)
      if (
        options.cert_file_name ||
        options.key_file_name ||
        options.passphrase ||
        options.dh_params_file_name ||
        options.ssl_prefer_low_memory_usage !== undefined
      ) {
        this.logger.warn(
          'SSL/TLS options are ignored when uwsApp is provided - the shared uWS instance controls TLS configuration.'
        );
      }
    }

    // Initialize handler executor with optional ModuleRef for DI support
    // Accept both our ModuleRef interface and NestJS ModuleRef, auto-wrap if needed
    // Normalize null to undefined for consistent "no DI" representation
    const rawModuleRef = options?.moduleRef ?? undefined;
    let moduleRef: ModuleRef | undefined = rawModuleRef;
    if (rawModuleRef && !('instances' in rawModuleRef)) {
      // It's a NestJS ModuleRef (doesn't have our DefaultModuleRef's instances property)
      // Wrap it with our adapter
      moduleRef = NestJsModuleRef.create(rawModuleRef as unknown as NestModuleRef);
    }
    this.handlerExecutor = new HandlerExecutor({ moduleRef });

    this.logger.log('UwsAdapter initialized');
  }

  /**
   * Create the uWebSockets.js server
   * Called by NestJS during application initialization
   * @param port - Port provided by NestJS (ignored - adapter uses configured port)
   *
   * Note: The adapter uses the port configured in constructor options (default: 8099).
   * This is intentional as uWebSockets.js requires explicit port configuration.
   *
   * In v2.0.0+, if a uWS App was provided in constructor options, this method
   * returns the existing instance instead of creating a new one.
   */
  create(_port: number, _options?: unknown): Promise<uWS.TemplatedApp> {
    // If uwsApp was provided in constructor, use it (v2.0.0+ HTTP + WebSocket integration)
    if (this.app) {
      if (this.isSharedApp) {
        this.logger.log('Using existing uWS App instance (shared with HTTP)');
      } else {
        this.logger.debug('create() called again - returning existing app instance');
      }
      return Promise.resolve(this.app);
    }

    // Determine whether to create a TLS-enabled app
    const { cert_file_name, key_file_name } = this.options;
    if (cert_file_name && key_file_name) {
      this.app = uWS.SSLApp({
        cert_file_name,
        key_file_name,
        passphrase: this.options.passphrase,
        dh_params_file_name: this.options.dh_params_file_name,
        ssl_prefer_low_memory_usage: this.options.ssl_prefer_low_memory_usage,
      });
      this.logger.log(
        `uWebSockets SSL server created (cert: ${cert_file_name}), will listen on port ${this.options.port}`
      );
    } else {
      // Warn if only one of cert/key was supplied - misconfiguration
      if (cert_file_name || key_file_name) {
        this.logger.warn(
          'SSL misconfiguration: both cert_file_name and key_file_name must be provided to enable TLS. ' +
            'Falling back to plain uWS.App().'
        );
      }
      this.app = uWS.App();
      this.logger.log(`uWebSockets server created, will listen on port ${this.options.port}`);
    }

    return Promise.resolve(this.app);
  }

  /**
   * Bind client connection handler
   * Sets up WebSocket routes and lifecycle handlers
   */
  bindClientConnect(
    _server: uWS.TemplatedApp,
    callback: (client: ExtendedWebSocket) => void
  ): void {
    this.logger.log('Setting up WebSocket routes...');

    this.app
      .ws(this.options.path, {
        compression: this.options.compression,
        maxPayloadLength: this.options.maxPayloadLength,
        idleTimeout: this.options.idleTimeout,
        maxLifetime: this.options.maxLifetime,
        maxBackpressure: this.options.maxBackpressure,
        closeOnBackpressureLimit: this.options.closeOnBackpressureLimit,
        sendPingsAutomatically: this.options.sendPingsAutomatically,

        open: (ws: uWS.WebSocket<WebSocketClient>) => {
          const extWs = ws as ExtendedWebSocket;
          const id = this.generateId();
          extWs.id = id;
          this.clients.set(id, extWs);

          // Create wrapped socket with room support
          const socket = new UwsSocketImpl(
            id,
            extWs,
            this.roomManager,
            this.broadcastToRooms.bind(this)
          );
          this.sockets.set(id, socket);

          try {
            // Call lifecycle hooks for all registered gateways
            this.gateways.forEach((_name, gateway) => {
              try {
                this.lifecycleHooksManager.callConnectionHook(gateway, extWs);
              } catch (error) {
                this.logger.error(
                  `Connection hook error for ${gateway.constructor?.name}: ${this.formatError(error)}`
                );
              }
            });

            if (this.wsHandler) {
              this.wsHandler.handleConnection(extWs);
            }
            callback(extWs);
          } catch (error) {
            this.logger.error(`Connection handler error: ${this.formatError(error)}`);
          }
        },

        message: (ws: uWS.WebSocket<WebSocketClient>, message: ArrayBuffer) => {
          const extWs = ws as ExtendedWebSocket;
          const data = Buffer.from(message).toString('utf-8');

          try {
            // Use custom handler if registered, otherwise use decorator-based routing
            // This prevents double-processing of messages
            if (this.wsHandler) {
              this.wsHandler.handleMessage(extWs, data);
            } else {
              // Use decorator-based routing when no custom handler is set
              this.handleDecoratorBasedMessage(extWs, data).catch((error) => {
                this.logger.error(
                  `Decorator routing error for client ${extWs.id}: ${this.formatError(error)}`
                );
              });
            }
          } catch (error) {
            this.logger.error(
              `Message handler error for client ${extWs.id}: ${this.formatError(error)}`
            );
          }
        },

        close: (ws: uWS.WebSocket<WebSocketClient>, _code: number, _message: ArrayBuffer) => {
          const extWs = ws as ExtendedWebSocket;
          const id = extWs.id;

          if (id) {
            // Remove client from all rooms
            this.roomManager.leaveAll(id);

            this.clients.delete(id);
            this.sockets.delete(id);
          }

          try {
            // Call lifecycle hooks for all registered gateways
            this.gateways.forEach((_name, gateway) => {
              try {
                this.lifecycleHooksManager.callDisconnectHook(gateway, extWs);
              } catch (error) {
                this.logger.error(
                  `Disconnect hook error for ${gateway.constructor?.name}: ${this.formatError(error)}`
                );
              }
            });

            if (this.wsHandler) {
              this.wsHandler.handleDisconnect(extWs);
            }
          } catch (error) {
            this.logger.error(`Disconnect handler error: ${this.formatError(error)}`);
          }
        },
      })
      .any(this.options.path, (res, _req) => {
        // Fallback for HTTP requests to WebSocket endpoint
        res.writeStatus('404 Not Found').end('WebSocket endpoint only');
      });

    this.logger.log('✓ WebSocket routes configured');

    // Start listening (only if not using shared app - HTTP server handles listening)
    if (!this.isSharedApp) {
      this.app.listen(this.options.port, (token) => {
        if (token) {
          this.listenSocket = token;
          this.logger.log(`✓ uWebSockets server listening on port ${this.options.port}`);
        } else {
          const errorMsg = `Failed to listen on port ${this.options.port} - port may be in use or unavailable`;
          this.logger.error(errorMsg);
          // Throw error asynchronously to crash the application
          // We can't throw directly here (async callback), so use process.nextTick
          // This ensures the application doesn't start if WebSocket server fails
          process.nextTick(() => {
            throw new Error(errorMsg);
          });
        }
      });
    } else {
      this.logger.log('✓ Skipping listen() - using shared uWS App (HTTP server manages lifecycle)');
    }
  }

  /**
   * Manually register a gateway for message handling
   * Supports multiple gateways - each gateway's handlers are registered independently
   * Call this after app.useWebSocketAdapter() but before app.listen()
   *
   * IMPORTANT: Duplicate Event Handlers
   * If multiple gateways register handlers for the same event, the LAST registered
   * handler will be invoked (last-match-wins semantics). Subsequent registrations for
   * the same event will overwrite previous handlers with a warning.
   *
   * Example:
   * ```typescript
   * // Gateway1 has @SubscribeMessage('message')
   * adapter.registerGateway(gateway1); // This handler is registered first
   *
   * // Gateway2 also has @SubscribeMessage('message')
   * adapter.registerGateway(gateway2); // This will overwrite gateway1's handler with a warning
   * // Now gateway2's handler will be used for 'message' events
   * ```
   *
   * To avoid conflicts, ensure each gateway uses unique event names or use namespacing:
   * - Gateway1: @SubscribeMessage('chat:message')
   * - Gateway2: @SubscribeMessage('game:message')
   *
   * @param gateway - The gateway instance to register
   */
  registerGateway(gateway: object): void {
    if (!gateway) {
      this.logger.warn('Cannot register null or undefined gateway');
      return;
    }

    const gatewayName = gateway.constructor?.name || 'Unknown';
    this.logger.log(`Registering gateway: ${gatewayName}`);

    // Check if gateway instance is already registered
    if (this.gatewaySet.has(gateway)) {
      this.logger.warn(
        `Gateway ${gatewayName} is already registered. Skipping duplicate registration.`
      );
      return;
    }

    // Store gateway instance (key=instance, value=name for logging)
    this.gateways.set(gateway, gatewayName);
    this.gatewaySet.add(gateway);

    // Scan gateway for @SubscribeMessage decorators
    const handlers = this.metadataScanner.scanForMessageHandlers(gateway);

    if (handlers.length === 0) {
      this.logger.warn(`No @SubscribeMessage handlers found in gateway ${gatewayName}`);
      return;
    }

    // Check for duplicate handlers across gateways before registering
    const duplicates: string[] = [];
    for (const handler of handlers) {
      const key =
        typeof handler.message === 'string' ? handler.message : JSON.stringify(handler.message);

      if (this.messageRouter.hasHandler(handler.message)) {
        duplicates.push(key);
      }
    }

    if (duplicates.length > 0) {
      this.logger.warn(
        `Gateway ${gatewayName} has ${duplicates.length} handler(s) that will overwrite existing handlers: ${duplicates.join(', ')}. ` +
          `Consider using unique event names or namespacing (e.g., 'gateway:event') to avoid conflicts.`
      );
    }

    // Register handlers with the message router
    this.messageRouter.registerHandlers(handlers);

    this.logger.log(
      `Registered ${handlers.length} message handlers from ${gatewayName}: ${handlers.map((h) => (typeof h.message === 'string' ? h.message : JSON.stringify(h.message))).join(', ')}`
    );

    // Call afterInit lifecycle hook
    this.lifecycleHooksManager.callInitHook(gateway, this.app);
  }

  /**
   * Bind message handlers (NestJS decorator-based routing)
   *
   * IMPORTANT: This adapter does NOT use NestJS's automatic bindMessageHandlers mechanism.
   * Instead, you must manually call registerGateway() to register your gateway.
   *
   * Why manual registration?
   * - Better control over metadata scanning and handler registration timing
   * - Explicit gateway lifecycle management (afterInit, handleConnection, handleDisconnect)
   * - Clearer separation between adapter initialization and gateway registration
   * - Allows for custom handler registration strategies
   *
   * This method is called by NestJS but intentionally ignored by this adapter.
   *
   * @param gateway - The gateway instance (ignored)
   * @param handlers - Message mapping properties (ignored)
   * @param _transform - Transform function (ignored)
   *
   * @see registerGateway() for the preferred registration method
   */
  bindMessageHandlers(
    gateway: unknown,
    handlers: MessageMappingProperties[],
    _transform: (data: unknown) => Observable<unknown>
  ): void {
    // Warn on first call only if no gateways have been registered yet
    // This prevents false warnings when developers correctly use registerGateway()
    if (!this.bindMessageHandlersCalled && this.gateways.size === 0) {
      this.logger.warn(
        'bindMessageHandlers() is not used by UwsAdapter. ' +
          'Please call adapter.registerGateway(gateway) manually after app.useWebSocketAdapter(). ' +
          'See class documentation for examples.'
      );
    }

    this.bindMessageHandlersCalled = true;

    this.logger.debug(
      `bindMessageHandlers called (ignored) - gateway: ${gateway?.constructor?.name}, handlers: ${handlers?.length || 0}`
    );
  }

  /**
   * Close the server and all client connections
   */
  close(_server: unknown): void {
    // Only close the listen socket if we own it (not shared with HTTP server)
    if (this.listenSocket && !this.isSharedApp) {
      uWS.us_listen_socket_close(this.listenSocket);
      this.listenSocket = false;
      this.logger.log('Server socket closed');
    } else if (this.isSharedApp) {
      this.logger.log(
        'Skipping socket close - using shared uWS App (HTTP server manages lifecycle)'
      );
    }

    // Close all client connections
    this.clients.forEach((client, id) => {
      try {
        client.close();
      } catch (error) {
        this.logger.warn(`Failed to close client ${id}: ${this.formatError(error)}`);
      }
    });

    this.clients.clear();
    this.sockets.clear();
    this.roomManager.clear();
    this.gateways.clear();
    this.gatewaySet = new WeakSet<object>(); // Reset gateway tracking for re-registration
    this.logger.log('All client connections closed');
  }

  /**
   * Dispose of the adapter
   */
  dispose(): void {
    this.close(null);
  }

  /**
   * Register custom WebSocket handlers
   * Used by gateways to handle connection lifecycle
   */
  setWebSocketHandler(handler: {
    handleConnection: (ws: ExtendedWebSocket) => void;
    handleMessage: (ws: ExtendedWebSocket, data: string) => void;
    handleDisconnect: (ws: ExtendedWebSocket) => void;
  }): void {
    this.wsHandler = handler;
    this.logger.log('WebSocket handler registered');
  }

  /**
   * Send a message to a specific client
   * @param clientId - Client identifier
   * @param data - Data to send (will be JSON stringified)
   * @returns true if sent successfully, false otherwise
   */
  sendToClient(clientId: string, data: unknown): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn(`Client ${clientId} not found`);
      return false;
    }

    const message = this.serializeMessage(data, `client ${clientId}`);
    if (!message) return false;

    try {
      return this.sendMessage(client, message, clientId);
    } catch (error) {
      this.logger.error(`Failed to send to client ${clientId}: ${this.formatError(error)}`);
      return false;
    }
  }

  /**
   * Broadcast a message to all connected clients
   * @param data - Data to send (will be JSON stringified)
   */
  broadcast(data: unknown): void {
    const message = this.serializeMessage(data, 'broadcast');
    if (!message) return;

    const dropped = this.sendToMultipleClients(this.clients, message);

    // Log warning if messages were dropped due to backpressure
    if (dropped > 0) {
      this.logger.warn(
        `Broadcast backpressure: ${dropped} message(s) dropped out of ${this.clients.size} clients`
      );
    }
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get iterator over connected client IDs (memory-efficient)
   * Use this for large client counts to avoid array allocation
   */
  getClientIdIterator(): IterableIterator<string> {
    return this.clients.keys();
  }

  /**
   * Get all connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a client is connected
   */
  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Get a wrapped socket by client ID
   * @param clientId - Client identifier
   * @returns UwsSocket instance or undefined
   */
  getSocket(clientId: string): UwsSocketImpl | undefined {
    return this.sockets.get(clientId);
  }

  /**
   * Broadcast to specific rooms
   * @param event - Event name
   * @param data - Data to send
   * @param rooms - Optional array of room names (if not provided, broadcasts to all)
   * @param except - Optional array of client IDs to exclude from broadcast
   */
  private broadcastToRooms(
    event: string,
    data: unknown,
    rooms?: string[],
    except?: string[]
  ): void {
    const targetClients = this.getTargetClients(rooms, except);
    const message = this.serializeMessage({ event, data }, 'room broadcast');
    if (!message) return;

    const clientMap = new Map<string, ExtendedWebSocket>();
    targetClients.forEach((clientId) => {
      const client = this.clients.get(clientId);
      if (client) clientMap.set(clientId, client);
    });

    const dropped = this.sendToMultipleClients(clientMap, message);

    // Log warning if messages were dropped due to backpressure
    if (dropped > 0) {
      this.logger.warn(
        `Room broadcast backpressure: ${dropped} message(s) dropped out of ${clientMap.size} clients`
      );
    }
  }

  /**
   * Handle decorator-based message routing
   * Parses incoming message and routes to appropriate handler across all registered gateways
   */
  private async handleDecoratorBasedMessage(
    client: ExtendedWebSocket,
    rawData: string
  ): Promise<void> {
    // Only process if we have gateways registered and handlers available
    if (this.gateways.size === 0 || this.messageRouter.getHandlerCount() === 0) {
      return;
    }

    try {
      // Parse the message
      const parsedMessage = JSON.parse(rawData);

      // Check if message has the expected format { event: string, data?: unknown }
      if (!parsedMessage || typeof parsedMessage !== 'object' || !parsedMessage.event) {
        this.logger.debug('Message does not have required event property, skipping routing');
        return;
      }

      // Check if handler exists for this event
      if (!this.messageRouter.hasHandler(parsedMessage.event)) {
        this.logger.debug(`No handler found for message: ${parsedMessage.event}`);
        return;
      }

      // Find the gateway and method name for this event
      const handlerInfo = this.findHandlerForEvent(parsedMessage.event);
      if (!handlerInfo) {
        this.logger.warn(`Could not find handler for event: ${parsedMessage.event}`);
        return;
      }

      // Get the wrapped socket (UwsSocketImpl) instead of raw client
      const clientId = client.id;
      if (!clientId) {
        this.logger.warn('Client has no ID, cannot get wrapped socket');
        return;
      }

      const wrappedSocket = this.sockets.get(clientId);
      if (!wrappedSocket) {
        this.logger.warn(`No wrapped socket found for client ${clientId}`);
        return;
      }

      // Execute handler with proper parameter injection
      const executionResult = await this.handlerExecutor.execute(
        handlerInfo.gateway,
        handlerInfo.methodName,
        wrappedSocket,
        parsedMessage.data
      );

      // If there was an error, log it
      if (!executionResult.success && executionResult.error) {
        this.logger.error(
          `Handler error for event '${parsedMessage.event}': ${executionResult.error.message}`
        );
        return;
      }

      // If handler returned a response, send it back to client
      if (executionResult.response !== undefined) {
        this.sendResponse(client, parsedMessage.event, executionResult.response);
      }
    } catch (error) {
      // JSON parse error or other issues
      this.logger.debug(`Failed to parse or route message: ${this.formatError(error)}`);
    }
  }

  /**
   * Find the gateway and method name for a given event
   * Searches through all registered gateways
   */
  private findHandlerForEvent(event: string): { gateway: object; methodName: string } | null {
    for (const gateway of this.gateways.keys()) {
      const methodName = this.metadataScanner.getMethodNameForEvent(gateway, event);
      if (methodName) {
        return { gateway, methodName };
      }
    }
    return null;
  }

  /**
   * Send a response back to the client
   * Formats the response in NestJS WebSocket format
   */
  private sendResponse(client: ExtendedWebSocket, event: string, data: unknown): void {
    const message = this.serializeMessage({ event, data }, `response to ${client.id}`);
    if (!message) return;

    try {
      this.sendMessage(client, message, client.id, event);
    } catch (error) {
      this.logger.error(
        `Failed to send response to client ${client.id}: ${this.formatError(error)}`
      );
    }
  }

  /**
   * Get target clients for broadcast
   * @internal
   */
  private getTargetClients(rooms?: string[], except?: string[]): Set<string> {
    let targetClients: Set<string>;

    if (rooms?.length) {
      targetClients = new Set<string>();
      for (const room of rooms) {
        const roomClients = this.roomManager.getClientsInRoom(room);
        roomClients.forEach((clientId) => targetClients.add(clientId));
      }
    } else {
      targetClients = new Set(this.clients.keys());
    }

    if (except?.length) {
      for (const clientId of except) {
        targetClients.delete(clientId);
      }
    }

    return targetClients;
  }

  /**
   * Send message to a single client and handle result
   * @internal
   */
  private sendMessage(
    client: ExtendedWebSocket,
    message: string,
    clientId?: string,
    event?: string
  ): boolean {
    const result = client.send(message);
    const id = clientId || client.id || 'unknown';
    const eventInfo = event ? ` (event: ${event})` : '';

    // uWebSockets.js send() returns:
    // 0 = success (sent immediately)
    // 1 = backpressure (buffered, will be sent when possible - not a failure)
    // 2 = dropped (message lost due to buffer overflow)
    if (result === 2) {
      this.logger.warn(`Message dropped for client ${id} due to backpressure${eventInfo}`);
      return false;
    }
    return true;
  }

  /**
   * Send message to multiple clients and track dropped messages
   * @internal
   * @returns Number of messages dropped due to backpressure
   */
  private sendToMultipleClients(clients: Map<string, ExtendedWebSocket>, message: string): number {
    let dropped = 0;

    clients.forEach((client, id) => {
      try {
        const result = client.send(message);
        if (result === 2) {
          dropped++;
        }
      } catch (error) {
        this.logger.error(`Failed to send to client ${id}: ${this.formatError(error)}`);
      }
    });

    return dropped;
  }

  /**
   * Generate a unique client ID
   */
  private generateId(): string {
    return randomBytes(8).toString('hex');
  }

  /**
   * Serialize data to JSON string
   * @param data - Data to serialize
   * @param context - Context for error logging
   * @returns Serialized string or null if serialization fails
   */
  private serializeMessage(data: unknown, context: string): string | null {
    try {
      return JSON.stringify(data);
    } catch (error) {
      this.logger.error(`Failed to serialize message for ${context}: ${this.formatError(error)}`);
      return null;
    }
  }

  /**
   * Format error for logging
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
