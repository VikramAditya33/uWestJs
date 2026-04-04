import { CanActivate, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply guards to a class or method
 * Guards are executed before the handler and can deny access
 *
 * @param guards - Guard classes to apply
 *
 * @example
 * ```typescript
 * @UseGuards(AuthGuard, RoleGuard)
 * @SubscribeMessage('protected')
 * handleProtected() {
 *   return 'Access granted';
 * }
 * ```
 */
export function UseGuards(...guards: Type<CanActivate>[]): ClassDecorator & MethodDecorator {
  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor
  ): void | PropertyDescriptor => {
    if (propertyKey) {
      // Method decorator - merge with existing guards
      // For static methods, target is the constructor itself; for instance methods, it's the prototype
      const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;
      const existingGuards: Type<CanActivate>[] =
        Reflect.getMetadata(GUARDS_METADATA, metadataTarget, propertyKey) || [];
      
      Reflect.defineMetadata(
        GUARDS_METADATA,
        [...existingGuards, ...guards],
        metadataTarget,
        propertyKey
      );
      return descriptor;
    } else {
      // Class decorator
      Reflect.defineMetadata(GUARDS_METADATA, guards, target);
      return;
    }
  };

  return decorator as ClassDecorator & MethodDecorator;
}
