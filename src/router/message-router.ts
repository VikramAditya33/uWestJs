import { Logger } from '@nestjs/common';
import { MessageHandler } from './metadata-scanner';

/**
 * Represents an incoming WebSocket message
 */
export interface IncomingMessage {
  /**
   * The event/message type
   */
  event: string;

  /**
   * The message payload/data
   */
  data?: unknown;
}

/**
 * Result of routing and executing a message handler
 */
export interface RoutingResult {
  /**
   * Whether a handler was found and executed
   */
  handled: boolean;

  /**
   * The return value from the handler (if any)
   */
  response?: unknown;

  /**
   * Error that occurred during execution (if any)
   */
  error?: Error;
}

/**
 * Routes incoming WebSocket messages to the appropriate handlers
 */
export class MessageRouter {
  private readonly logger = new Logger(MessageRouter.name);
  private readonly handlers = new Map<string, MessageHandler>();

  /**
   * Registers message handlers from the routing table
   * @param handlers - Array of message handlers to register
   */
  registerHandlers(handlers: MessageHandler[]): void {
    for (const handler of handlers) {
      if (this.handlers.has(handler.message)) {
        this.logger.warn(
          `Duplicate handler for message '${handler.message}', overwriting previous handler`
        );
      }

      this.handlers.set(handler.message, handler);
      this.logger.debug(`Registered handler: ${handler.message} -> ${handler.methodName}`);
    }

    this.logger.log(`Registered ${handlers.length} message handlers`);
  }

  /**
   * Routes an incoming message to the appropriate handler
   * @param message - The incoming message to route
   * @param client - The WebSocket client that sent the message
   * @returns Promise resolving to the routing result
   */
  async route(message: IncomingMessage, client: unknown): Promise<RoutingResult> {
    const handler = this.handlers.get(message.event);

    if (!handler) {
      this.logger.debug(`No handler found for message: ${message.event}`);
      return { handled: false };
    }

    try {
      this.logger.debug(`Routing message '${message.event}' to ${handler.methodName}`);

      const result = await handler.callback(client, message.data);

      return { handled: true, response: result };
    } catch (error) {
      this.logger.error(
        `Error executing handler for '${message.event}': ${this.formatError(error)}`
      );

      return { handled: true, error: this.toError(error) };
    }
  }

  /**
   * Checks if a handler exists for the given message pattern
   * @param pattern - The message pattern to check
   * @returns True if a handler exists
   */
  hasHandler(pattern: string): boolean {
    return this.handlers.has(pattern);
  }

  /**
   * Gets all registered message patterns
   * @returns Array of registered patterns
   */
  getPatterns(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Clears all registered handlers
   */
  clear(): void {
    this.handlers.clear();
    this.logger.log('Cleared all message handlers');
  }

  /**
   * Gets the number of registered handlers
   */
  getHandlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Formats error for logging
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Converts unknown error to Error instance
   */
  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
