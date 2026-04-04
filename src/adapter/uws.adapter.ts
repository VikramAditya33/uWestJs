import { WebSocketAdapter, Logger } from '@nestjs/common';
import { MessageMappingProperties } from '@nestjs/websockets';
import { Observable } from 'rxjs';
import * as uWS from 'uWebSockets.js';
import { randomBytes } from 'crypto';
import {
  UwsAdapterOptions,
  ResolvedUwsAdapterOptions,
  WebSocketClient,
} from '../interfaces';

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
  private static instance: UwsAdapter;
  private wsHandler?: {
    handleConnection: (ws: ExtendedWebSocket) => void;
    handleMessage: (ws: ExtendedWebSocket, data: string) => void;
    handleDisconnect: (ws: ExtendedWebSocket) => void;
  };

  constructor(_appInstance: unknown, options?: UwsAdapterOptions) {
    // Apply default options
    this.options = {
      maxPayloadLength: options?.maxPayloadLength ?? 16 * 1024,
      idleTimeout: options?.idleTimeout ?? 60,
      compression: options?.compression ?? uWS.SHARED_COMPRESSOR,
      port: options?.port ?? 8099,
      path: options?.path ?? '/*',
      cors: options?.cors,
    };

    UwsAdapter.instance = this;
    this.logger.log('UwsAdapter initialized');
  }

  /**
   * Get the singleton instance of the adapter
   * Useful for accessing the adapter from other parts of the application
   */
  static getInstance(): UwsAdapter | null {
    return UwsAdapter.instance || null;
  }

  /**
   * Create the uWebSockets.js server
   * Called by NestJS during application initialization
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
  bindClientConnect(_server: uWS.TemplatedApp, callback: (client: ExtendedWebSocket) => void): void {
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
            if (this.wsHandler) {
              this.wsHandler.handleMessage(extWs, data);
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
        this.logger.error(
          `Failed to listen on port ${this.options.port} - port may be in use`
        );
      }
    });
  }

  /**
   * Bind message handlers (NestJS decorator-based routing)
   * This is a no-op for now - will be implemented in Phase 2
   */
  bindMessageHandlers(
    _client: unknown,
    _handlers: MessageMappingProperties[],
    _transform: (data: unknown) => Observable<unknown>
  ): void {
    // Will be implemented in Phase 2 with decorator support
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
      client.send(message);
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

    this.clients.forEach((client, id) => {
      try {
        client.send(message);
        successCount++;
      } catch (error) {
        this.logger.error(`Failed to broadcast to client ${id}: ${this.formatError(error)}`);
        failCount++;
      }
    });

    this.logger.debug(`Broadcast complete: ${successCount} succeeded, ${failCount} failed`);
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
