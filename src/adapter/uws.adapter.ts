import { WebSocketAdapter, Logger } from '@nestjs/common';
import { MessageMappingProperties } from '@nestjs/websockets';
import { Observable } from 'rxjs';
import * as uWS from 'uWebSockets.js';
import { randomBytes } from 'crypto';
import type {
  UwsAdapterOptions,
  ResolvedUwsAdapterOptions,
} from '../interfaces/uws-options.interface';
import type { WebSocketClient } from '../interfaces/websocket-client.interface';
import { MetadataScanner } from '../router/metadata-scanner';
import { MessageRouter } from '../router/message-router';
import { HandlerExecutor } from '../router/handler-executor';
import { RoomManager } from '../rooms';
import { UwsSocketImpl } from '../socket/uws-socket';
import { LifecycleHooksManager } from './lifecycle-hooks';

/**
 * Extended WebSocket with client data
 */
interface ExtendedWebSocket extends uWS.WebSocket<WebSocketClient> {
  id?: string;
}

/**
 * High-performance WebSocket adapter using uWebSockets.js
 *
 * Supports dependency injection for guards, pipes, and filters when a ModuleRef is provided.
 * Pass a ModuleRef to enable guards/pipes/filters with constructor dependencies.
 *
 * @example
 * ```typescript
 * // Without DI (guards/pipes/filters must have no constructor dependencies)
 * const app = await NestFactory.create(AppModule);
 * app.useWebSocketAdapter(new UwsAdapter(app, {
 *   port: 8099,
 *   maxPayloadLength: 16 * 1024,
 *   idleTimeout: 60,
 * }));
 * ```
 *
 * @example
 * ```typescript
 * // With DI support (guards/pipes/filters can have constructor dependencies)
 * const app = await NestFactory.create(AppModule);
 * const moduleRef = app.get(ModuleRef); // Get NestJS ModuleRef
 * app.useWebSocketAdapter(new UwsAdapter(app, {
 *   port: 8099,
 *   moduleRef, // Enable DI for guards/pipes/filters
 * }));
 * ```
 */
export class UwsAdapter implements WebSocketAdapter {
  private app!: uWS.TemplatedApp;
  private listenSocket: false | uWS.us_listen_socket = false;
  private clients = new Map<string, ExtendedWebSocket>();
  private sockets = new Map<string, UwsSocketImpl>(); // Track wrapped sockets
  private readonly logger = new Logger(UwsAdapter.name);
  private readonly options: ResolvedUwsAdapterOptions;
  private readonly appInstance: unknown;
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
  private gatewayInstance?: object;

  constructor(appInstance: unknown, options?: UwsAdapterOptions) {
    // Store app instance to potentially access gateways later
    this.appInstance = appInstance;

    // Apply default options
    // Note: port will be set in create() using NestJS-provided port as fallback
    this.options = {
      maxPayloadLength: options?.maxPayloadLength ?? 16 * 1024,
      idleTimeout: options?.idleTimeout ?? 60,
      compression: options?.compression ?? uWS.SHARED_COMPRESSOR,
      port: options?.port ?? 8099, // Default to 8099 if not provided
      path: options?.path ?? '/*',
      cors: options?.cors,
    };

    // Initialize handler executor with optional ModuleRef for DI support
    this.handlerExecutor = new HandlerExecutor({ moduleRef: options?.moduleRef });

    this.logger.log('UwsAdapter initialized');
    this.logger.debug(`App instance type: ${appInstance?.constructor?.name || 'unknown'}`);
  }

  /**
   * Create the uWebSockets.js server
   * Called by NestJS during application initialization
   * @param port - Port provided by NestJS (ignored - adapter uses configured port)
   *
   * Note: The adapter uses the port configured in constructor options (default: 8099).
   * This is intentional as uWebSockets.js requires explicit port configuration.
   */
  create(_port: number, _options?: unknown): Promise<uWS.TemplatedApp> {
    this.app = uWS.App();
    this.logger.log(`uWebSockets server created, will listen on port ${this.options.port}`);
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

          this.logger.debug(`Client connected: ${id} (Total: ${this.clients.size})`);

          try {
            // Call lifecycle hook
            if (this.gatewayInstance) {
              this.lifecycleHooksManager.callConnectionHook(this.gatewayInstance, extWs);
            }

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
            this.logger.debug(`Client disconnected: ${id} (Total: ${this.clients.size})`);
          }

          try {
            // Call lifecycle hook
            if (this.gatewayInstance) {
              this.lifecycleHooksManager.callDisconnectHook(this.gatewayInstance, extWs);
            }

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

    // Start listening
    this.app.listen(this.options.port, (token) => {
      if (token) {
        this.listenSocket = token;
        this.logger.log(`✓ uWebSockets server listening on port ${this.options.port}`);
      } else {
        const errorMsg = `Failed to listen on port ${this.options.port} - port may be in use or unavailable`;
        this.logger.error(errorMsg);
        // Throw error to crash the application rather than running in broken state
        // This ensures the application doesn't start if WebSocket server fails
        throw new Error(errorMsg);
      }
    });
  }

  /**
   * Manually register a gateway for message handling
   * Call this after app.useWebSocketAdapter() but before app.listen()
   * @param gateway - The gateway instance to register
   */
  registerGateway(gateway: object): void {
    if (!gateway) {
      this.logger.warn('Cannot register null or undefined gateway');
      return;
    }

    this.logger.log(`Registering gateway: ${gateway.constructor?.name || 'Unknown'}`);

    // Store gateway instance
    this.gatewayInstance = gateway;

    // Scan gateway for @SubscribeMessage decorators
    const handlers = this.metadataScanner.scanForMessageHandlers(gateway);

    if (handlers.length === 0) {
      this.logger.warn(
        `No @SubscribeMessage handlers found in gateway ${gateway.constructor?.name}`
      );
      return;
    }

    // Register handlers with the message router
    this.messageRouter.registerHandlers(handlers);

    this.logger.log(
      `Registered ${handlers.length} message handlers: ${handlers.map((h) => h.message).join(', ')}`
    );

    // Call afterInit lifecycle hook
    this.lifecycleHooksManager.callInitHook(gateway, this.app);
  }

  /**
   * Bind message handlers (NestJS decorator-based routing)
   * We don't use this - we use registerGateway() instead for self-scanning
   *
   * @param gateway - The gateway instance (or client)
   * @param handlers - Message mapping properties (ignored)
   * @param _transform - Transform function (ignored)
   */
  bindMessageHandlers(
    gateway: unknown,
    handlers: MessageMappingProperties[],
    _transform: (data: unknown) => Observable<unknown>
  ): void {
    // We use registerGateway() for our self-scanning approach
    // This method is called by NestJS but we ignore it
    this.logger.debug(
      `bindMessageHandlers called (ignored) - gateway: ${gateway?.constructor?.name}, handlers: ${handlers?.length || 0}`
    );
  }

  /**
   * Close the server and all client connections
   */
  close(_server: unknown): void {
    if (this.listenSocket) {
      uWS.us_listen_socket_close(this.listenSocket);
      this.listenSocket = false;
      this.logger.log('Server socket closed');
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

    const stats = this.sendToMultipleClients(this.clients, message);
    this.logger.debug(
      `Broadcast complete: ${stats.success} succeeded, ${stats.dropped} dropped, ${stats.failed} failed`
    );
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
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

    const stats = this.sendToMultipleClients(clientMap, message);
    this.logger.debug(
      `Room broadcast complete: ${stats.success} succeeded, ${stats.dropped} dropped, ${stats.failed} failed (rooms: ${rooms?.join(', ') || 'all'})`
    );
  }

  /**
   * Handle decorator-based message routing
   * Parses incoming message and routes to appropriate handler
   */
  private async handleDecoratorBasedMessage(
    client: ExtendedWebSocket,
    rawData: string
  ): Promise<void> {
    // Only process if we have a gateway instance and handlers registered
    if (!this.gatewayInstance || this.messageRouter.getHandlerCount() === 0) {
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

      // Find the method name for this event
      const methodName = this.findMethodNameForEvent(parsedMessage.event);
      if (!methodName) {
        this.logger.warn(`Could not find method name for event: ${parsedMessage.event}`);
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

      this.logger.debug(
        `Using wrapped socket for client ${clientId}, has join: ${typeof wrappedSocket.join}`
      );

      // Execute handler with proper parameter injection
      const executionResult = await this.handlerExecutor.execute(
        this.gatewayInstance,
        methodName,
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
   * Find the method name for a given event
   * This is a helper to map event names back to method names
   */
  private findMethodNameForEvent(event: string): string | null {
    if (!this.gatewayInstance) return null;
    return this.metadataScanner.getMethodNameForEvent(this.gatewayInstance, event);
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

    // uWebSockets.js send() returns: 0 (success), 1 (backpressure), 2 (dropped)
    if (result === 2) {
      this.logger.warn(`Message dropped for client ${id} due to backpressure${eventInfo}`);
      return false;
    }
    if (result === 1) {
      this.logger.debug(`Message queued for client ${id} (backpressure${eventInfo})`);
    }
    return true;
  }

  /**
   * Send message to multiple clients and track statistics
   * @internal
   */
  private sendToMultipleClients(
    clients: Map<string, ExtendedWebSocket>,
    message: string
  ): { success: number; dropped: number; failed: number } {
    let success = 0;
    let dropped = 0;
    let failed = 0;

    clients.forEach((client, id) => {
      try {
        const result = client.send(message);
        if (result === 2) {
          dropped++;
        } else {
          success++;
        }
      } catch (error) {
        this.logger.error(`Failed to send to client ${id}: ${this.formatError(error)}`);
        failed++;
      }
    });

    return { success, dropped, failed };
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
