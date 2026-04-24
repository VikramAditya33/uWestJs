import { Logger } from '@nestjs/common';
import 'reflect-metadata';

/**
 * Metadata keys used by @SubscribeMessage decorator
 * These match NestJS's internal metadata keys from @nestjs/websockets
 */
const MESSAGE_MAPPING_METADATA = 'websockets:message_mapping'; // Flag indicating this is a message handler
const MESSAGE_METADATA = 'message'; // The actual message pattern/event name

/**
 * Represents a message handler discovered from decorators
 */
export interface MessageHandler {
  /**
   * The message pattern/event name to match
   * Supports both string patterns and object patterns for NestJS compatibility
   */
  message: string | Record<string, unknown>;

  /**
   * Pre-computed stable JSON for object pattern matching
   * Improves lookup performance by avoiding repeated sorting
   */
  messageKey?: string;

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
  private readonly cache = new WeakMap<object, MessageHandler[]>();

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

      // Check if this method has the @SubscribeMessage decorator
      const hasMessageMapping = Reflect.getMetadata(MESSAGE_MAPPING_METADATA, method);

      if (hasMessageMapping !== undefined) {
        // Get the actual message pattern from MESSAGE_METADATA
        const messagePattern = Reflect.getMetadata(MESSAGE_METADATA, method);

        if (messagePattern === undefined) {
          this.logger.warn(
            `Handler ${methodName} has MESSAGE_MAPPING_METADATA but no MESSAGE_METADATA. Skipping.`
          );
          continue;
        }

        // Validate message pattern type
        const isValidType =
          typeof messagePattern === 'string' ||
          (typeof messagePattern === 'object' &&
            messagePattern !== null &&
            !Array.isArray(messagePattern));

        if (!isValidType) {
          this.logger.warn(
            `Handler ${methodName} has invalid message pattern type: ${typeof messagePattern}. Expected string or object.`
          );
          continue; // Skip invalid handlers
        }

        handlers.push({
          message: messagePattern,
          messageKey:
            typeof messagePattern === 'object'
              ? JSON.stringify(this.sortObjectKeys(messagePattern))
              : undefined,
          methodName,
          callback: method.bind(instance),
        });

        this.logger.debug(`Discovered handler: ${methodName} -> ${JSON.stringify(messagePattern)}`);
      }
    }

    return handlers;
  }

  /**
   * Gets all method names from a prototype chain, excluding constructor
   * Walks up the prototype chain to support inheritance
   */
  private getMethodNames(prototype: object): string[] {
    const methodNames = new Set<string>();
    let current = prototype;

    // Walk up the prototype chain until we reach Object.prototype
    while (current && current !== Object.prototype) {
      Object.getOwnPropertyNames(current)
        .filter(
          (name) =>
            name !== 'constructor' &&
            typeof (current as Record<string, unknown>)[name] === 'function'
        )
        .forEach((name) => methodNames.add(name));

      current = Object.getPrototypeOf(current);
    }

    return Array.from(methodNames);
  }

  /**
   * Gets the method name for a specific event/message pattern
   * Supports both string and object pattern matching
   * Auto-scans if the instance hasn't been scanned yet
   * @param instance - The gateway instance
   * @param event - The event/message pattern to look up
   * @returns The method name if found, null otherwise
   */
  getMethodNameForEvent(instance: object, event: string | Record<string, unknown>): string | null {
    // Auto-scan if not cached to prevent subtle bugs from forgetting to scan first
    const handlers = this.scanForMessageHandlers(instance);
    if (handlers.length === 0) return null;

    // Pre-compute eventKey for object patterns to avoid repeated serialization
    const eventKey =
      typeof event === 'object' && event !== null
        ? JSON.stringify(this.sortObjectKeys(event))
        : undefined;

    const handler = handlers.find((h) => {
      // String pattern matching
      if (typeof h.message === 'string' && typeof event === 'string') {
        return h.message === event;
      }
      // Object pattern matching - use pre-computed messageKey for performance
      if (
        typeof h.message === 'object' &&
        h.message !== null &&
        typeof event === 'object' &&
        event !== null
      ) {
        return h.messageKey === eventKey;
      }
      return false;
    });

    return handler ? handler.methodName : null;
  }

  /**
   * Recursively sorts object keys for stable serialization
   * @private
   */
  private sortObjectKeys(
    obj: Record<string, unknown>,
    seen = new WeakSet<object>()
  ): Record<string, unknown> {
    if (seen.has(obj)) {
      throw new Error('Circular reference detected in message pattern');
    }
    seen.add(obj);

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const value = obj[key];
      sorted[key] =
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? this.sortObjectKeys(value as Record<string, unknown>, seen)
          : value;
    }
    seen.delete(obj);
    return sorted;
  }
}
