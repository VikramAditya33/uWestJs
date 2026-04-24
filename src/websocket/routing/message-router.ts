import { Logger } from '@nestjs/common';
import { MessageHandler } from './metadata-scanner';

/**
 * Represents an incoming WebSocket message
 */
export interface IncomingMessage {
  /**
   * The event/message type
   * Supports both string events and object patterns
   */
  event: string | Record<string, unknown>;

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
   *
   * Note: Duplicate handlers are overwritten with a warning.
   */
  registerHandlers(handlers: MessageHandler[]): void {
    for (const handler of handlers) {
      const key = this.getHandlerKey(handler.message);

      if (this.handlers.has(key)) {
        this.logger.warn(`Duplicate handler for message '${key}', overwriting previous handler`);
      }

      this.handlers.set(key, handler);
      this.logger.debug(`Registered handler: ${key} -> ${handler.methodName}`);
    }

    this.logger.log(`Registered ${this.handlers.size} message handlers`);
  }

  /**
   * Routes an incoming message to the appropriate handler
   * @param message - The incoming message to route
   * @param client - The WebSocket client that sent the message
   * @returns Promise resolving to the routing result
   */
  async route(message: IncomingMessage, client: unknown): Promise<RoutingResult> {
    const handler = this.findHandler(message.event);

    if (!handler) {
      this.logger.debug(`No handler found for message: ${JSON.stringify(message.event)}`);
      return { handled: false };
    }

    try {
      this.logger.debug(
        `Routing message '${JSON.stringify(message.event)}' to ${handler.methodName}`
      );

      const result = await handler.callback(client, message.data);

      return { handled: true, response: result };
    } catch (error) {
      this.logger.error(
        `Error executing handler for '${JSON.stringify(message.event)}': ${this.formatError(error)}`
      );

      return { handled: true, error: this.toError(error) };
    }
  }

  /**
   * Checks if a handler exists for the given message pattern
   * @param pattern - The message pattern to check
   * @returns True if a handler exists
   */
  hasHandler(pattern: string | Record<string, unknown>): boolean {
    const key = this.getHandlerKey(pattern);
    return this.handlers.has(key);
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
   * Finds a handler for the given event
   * Supports both string and object pattern matching
   * @private
   */
  private findHandler(event: string | Record<string, unknown>): MessageHandler | undefined {
    const key = this.getHandlerKey(event);
    return this.handlers.get(key);
  }

  /**
   * Converts a message pattern to a consistent string key for storage
   *
   * Note: Uses JSON.stringify for object patterns, which has the following behaviors:
   * - undefined values are omitted: {a: 1, b: undefined} becomes {"a":1}
   * - NaN and Infinity serialize to null: {x: NaN} becomes {"x":null}
   * - Functions and symbols are omitted
   *
   * This means patterns like {a: 1, b: undefined} will match {a: 1}.
   * If strict structural equality is required, avoid using undefined, NaN, or Infinity in patterns.
   *
   * @private
   */
  private getHandlerKey(pattern: string | Record<string, unknown>): string {
    if (typeof pattern === 'string') {
      return pattern;
    }
    // For object patterns, create a stable JSON string key with sorted keys (recursively)
    return JSON.stringify(this.sortObjectKeys(pattern));
  }

  /**
   * Recursively sorts object keys for stable serialization
   * @private
   */
  private sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = this.sortValue(obj[key]);
    }
    return sorted;
  }

  /**
   * Recursively sorts values (handles objects, arrays, and primitives)
   * @private
   */
  private sortValue(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sortValue(item));
    }
    return this.sortObjectKeys(value as Record<string, unknown>);
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
