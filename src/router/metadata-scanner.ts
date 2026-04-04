import { Logger } from '@nestjs/common';
import 'reflect-metadata';

/**
 * Metadata key used by @SubscribeMessage decorator
 * This matches NestJS's internal metadata key
 */
const MESSAGE_MAPPING_METADATA = 'microservices:message_mapping';

/**
 * Represents a message handler discovered from decorators
 */
export interface MessageHandler {
  /**
   * The message pattern/event name to match
   */
  message: string;

  /**
   * The method name on the gateway class
   */
  methodName: string;

  /**
   * The actual handler function bound to the gateway instance
   */
  callback: (...args: unknown[]) => unknown;
}

/**
 * Scans gateway classes for @SubscribeMessage decorators and builds a routing table
 */
export class MetadataScanner {
  private readonly logger = new Logger(MetadataScanner.name);
  private readonly cache = new Map<object, MessageHandler[]>();

  /**
   * Scans a gateway instance for @SubscribeMessage decorators
   * @param instance - The gateway instance to scan
   * @returns Array of discovered message handlers
   */
  scanForMessageHandlers(instance: object): MessageHandler[] {
    const cached = this.cache.get(instance);
    if (cached) {
      return cached;
    }

    const handlers = this.discoverHandlers(instance);
    this.cache.set(instance, handlers);

    this.logger.log(`Scanned gateway, found ${handlers.length} message handlers`);
    return handlers;
  }

  /**
   * Discovers message handlers from a gateway instance
   */
  private discoverHandlers(instance: object): MessageHandler[] {
    const handlers: MessageHandler[] = [];
    const prototype = Object.getPrototypeOf(instance);
    const methodNames = this.getMethodNames(prototype);

    for (const methodName of methodNames) {
      const method = prototype[methodName];
      const messagePattern = Reflect.getMetadata(MESSAGE_MAPPING_METADATA, method);

      if (messagePattern !== undefined) {
        handlers.push({
          message: messagePattern,
          methodName,
          callback: method.bind(instance),
        });

        this.logger.debug(`Discovered handler: ${methodName} -> ${messagePattern}`);
      }
    }

    return handlers;
  }

  /**
   * Gets all method names from a prototype, excluding constructor
   */
  private getMethodNames(prototype: object): string[] {
    return Object.getOwnPropertyNames(prototype).filter(
      (name) =>
        name !== 'constructor' && typeof prototype[name as keyof typeof prototype] === 'function'
    );
  }

  /**
   * Clears the metadata cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Gets the number of cached gateway instances
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
