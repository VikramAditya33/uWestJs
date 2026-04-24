import { ExceptionFilter, Type } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply exception filters to a class or method
 * Exception filters catch and handle errors thrown by handlers
 *
 * @param filters - Exception filter classes or instances to apply
 *
 * @example
 * ```typescript
 * // Using filter class (resolved from DI)
 * @UseFilters(WsExceptionFilter)
 * @SubscribeMessage('risky')
 * handleRisky(@MessageBody() data: any) {
 *   throw new WsException('Something went wrong');
 * }
 *
 * // Using filter instance (pre-configured)
 * @UseFilters(new CustomFilter({ logLevel: 'debug' }))
 * @SubscribeMessage('custom')
 * handleCustom(@MessageBody() data: any) {
 *   // ...
 * }
 * ```
 */
export function UseFilters(
  ...filters: (Type<ExceptionFilter> | ExceptionFilter)[]
): ClassDecorator & MethodDecorator {
  // No-op if no filters provided
  if (filters.length === 0) {
    return (() => {}) as ClassDecorator & MethodDecorator;
  }

  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor
  ): void | PropertyDescriptor => {
    if (propertyKey) {
      // Method decorator - merge with existing filters and deduplicate
      // For static methods, target is the constructor itself; for instance methods, it's the prototype
      const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;
      const existingFilters: (Type<ExceptionFilter> | ExceptionFilter)[] =
        Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, metadataTarget, propertyKey) || [];

      Reflect.defineMetadata(
        EXCEPTION_FILTERS_METADATA,
        [...new Set([...existingFilters, ...filters])],
        metadataTarget,
        propertyKey
      );
      return descriptor;
    } else {
      // Class decorator - merge with existing filters and deduplicate
      const existingFilters: (Type<ExceptionFilter> | ExceptionFilter)[] =
        Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, target) || [];

      Reflect.defineMetadata(
        EXCEPTION_FILTERS_METADATA,
        [...new Set([...existingFilters, ...filters])],
        target
      );
      return;
    }
  };

  return decorator as ClassDecorator & MethodDecorator;
}
