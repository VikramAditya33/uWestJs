import { ExceptionFilter, Type } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply exception filters to a class or method
 * Exception filters catch and handle errors thrown by handlers
 *
 * @param filters - Exception filter classes to apply
 *
 * @example
 * ```typescript
 * @UseFilters(WsExceptionFilter)
 * @SubscribeMessage('risky')
 * handleRisky(@MessageBody() data: any) {
 *   throw new WsException('Something went wrong');
 * }
 * ```
 */
export function UseFilters(...filters: Type<ExceptionFilter>[]): ClassDecorator & MethodDecorator {
  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor
  ): void | PropertyDescriptor => {
    if (propertyKey) {
      // Method decorator - merge with existing filters
      // For static methods, target is the constructor itself; for instance methods, it's the prototype
      const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;
      const existingFilters: Type<ExceptionFilter>[] =
        Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, metadataTarget, propertyKey) || [];
      
      Reflect.defineMetadata(
        EXCEPTION_FILTERS_METADATA,
        [...existingFilters, ...filters],
        metadataTarget,
        propertyKey
      );
      return descriptor;
    } else {
      // Class decorator
      Reflect.defineMetadata(EXCEPTION_FILTERS_METADATA, filters, target);
      return;
    }
  };

  return decorator as ClassDecorator & MethodDecorator;
}
