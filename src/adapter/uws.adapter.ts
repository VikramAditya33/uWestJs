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

/**
 * Extended WebSocket with client data
 */
interface ExtendedWebSocket extends uWS.WebSocket<WebSocketClient> {
  id?: string;
}

/**
 * High-performance WebSocket adapter using uWebSockets.js
 *
 * @example
 * ```typescript
 * const app = await NestFactory.create(AppModule);
 * app.useWebSocketAdapter(new UwsAdapter(app, {
 *   port: 8099,
 *   maxPayloadLength: 16 * 1024,
 *   idleTimeout: 60,
 * }));
 * ```
 */
export class UwsAdapter implements WebSocketAdapter {
  private app!: uWS.TemplatedApp;
  private listenSocket: false | uWS.us_listen_socket = false;
  private clients = new Map<string, ExtendedWebSocket>();
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
  private readonly handlerExecutor = new HandlerExecutor();
  private gatewayInstance?: object;

  constructor(_appInstance: unknown, options?: UwsAdapterOptions) {
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

    this.logger.log('UwsAdapter initialized');
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

          this.logger.debug(`Client connected: ${id} (Total: ${this.clients.size})`);

          try {
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
            // First, try custom handler if registered
            if (this.wsHandler) {
              this.wsHandler.handleMessage(extWs, data);
            }

            // Then, try decorator-based routing
            this.handleDecoratorBasedMessage(extWs, data).catch((error) => {
              this.logger.error(
                `Decorator routing error for client ${extWs.id}: ${this.formatError(error)}`
              );
            });
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
            this.clients.delete(id);
            this.logger.debug(`Client disconnected: ${id} (Total: ${this.clients.size})`);
          }

          try {
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
   * Bind message handlers (NestJS decorator-based routing)
   * Scans the gateway for @SubscribeMessage decorators and sets up routing
   *
   * @param client - The gateway instance
   * @param handlers - Message mapping properties (not used, we scan for decorators)
   * @param transform - Transform function (not used in this implementation)
   */
  bindMessageHandlers(
    client: unknown,
    _handlers: MessageMappingProperties[],
    _transform: (data: unknown) => Observable<unknown>
  ): void {
    if (!client || typeof client !== 'object') {
      this.logger.warn('Invalid gateway instance provided to bindMessageHandlers');
      return;
    }

    // Store gateway instance for later use
    this.gatewayInstance = client;

    // Scan gateway for @SubscribeMessage decorators
    const handlers = this.metadataScanner.scanForMessageHandlers(client);

    if (handlers.length === 0) {
      this.logger.debug('No @SubscribeMessage handlers found in gateway');
      return;
    }

    // Register handlers with the message router
    this.messageRouter.registerHandlers(handlers);

    this.logger.log(
      `Registered ${handlers.length} message handlers from gateway: ${handlers.map((h) => h.message).join(', ')}`
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
      const result = client.send(message);
      // uWebSockets.js send() returns: 0 (success), 1 (backpressure), 2 (dropped)
      if (result === 2) {
        this.logger.warn(`Message dropped for client ${clientId} due to backpressure`);
        return false;
      }
      if (result === 1) {
        this.logger.debug(`Message queued for client ${clientId} (backpressure)`);
      }
      return true;
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

    let successCount = 0;
    let failCount = 0;
    let droppedCount = 0;

    this.clients.forEach((client, id) => {
      try {
        const result = client.send(message);
        // uWebSockets.js send() returns: 0 (success), 1 (backpressure), 2 (dropped)
        if (result === 2) {
          this.logger.warn(`Broadcast message dropped for client ${id} due to backpressure`);
          droppedCount++;
        } else {
          successCount++;
          if (result === 1) {
            this.logger.debug(`Broadcast message queued for client ${id} (backpressure)`);
          }
        }
      } catch (error) {
        this.logger.error(`Failed to broadcast to client ${id}: ${this.formatError(error)}`);
        failCount++;
      }
    });

    this.logger.debug(
      `Broadcast complete: ${successCount} succeeded, ${droppedCount} dropped, ${failCount} failed`
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

      // Get the handler
      const handlers = this.messageRouter.getPatterns();
      const handlerIndex = handlers.indexOf(parsedMessage.event);
      if (handlerIndex === -1) return;

      // Find the method name for this event
      const methodName = this.findMethodNameForEvent(parsedMessage.event);
      if (!methodName) {
        this.logger.warn(`Could not find method name for event: ${parsedMessage.event}`);
        return;
      }

      // Execute handler with proper parameter injection
      const executionResult = await this.handlerExecutor.execute(
        this.gatewayInstance,
        methodName,
        client,
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
    // Scan the gateway instance for the method with this event
    if (!this.gatewayInstance) return null;

    const handlers = (
      this.metadataScanner as unknown as {
        cache: Map<object, Array<{ message: string; methodName: string }>>;
      }
    ).cache.get(this.gatewayInstance);
    if (!handlers) return null;

    const handler = handlers.find((h) => h.message === event);
    return handler ? handler.methodName : null;
  }

  /**
   * Send a response back to the client
   * Formats the response in NestJS WebSocket format
   */
  private sendResponse(client: ExtendedWebSocket, event: string, data: unknown): void {
    const response = {
      event,
      data,
    };

    const message = this.serializeMessage(response, `response to ${client.id}`);
    if (!message) return;

    try {
      const result = client.send(message);
      // uWebSockets.js send() returns: 0 (success), 1 (backpressure), 2 (dropped)
      if (result === 2) {
        this.logger.warn(
          `Response dropped for client ${client.id} due to backpressure (event: ${event})`
        );
      } else if (result === 1) {
        this.logger.debug(
          `Response queued for client ${client.id} (backpressure, event: ${event})`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send response to client ${client.id}: ${this.formatError(error)}`
      );
    }
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
