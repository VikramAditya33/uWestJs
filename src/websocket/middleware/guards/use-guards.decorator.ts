import { CanActivate, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply guards to a class or method
 * Guards are executed before the handler and can deny access
 *
 * @param guards - Guard classes or instances to apply
 *
 * @example
 * ```typescript
 * // Using guard class (resolved from DI)
 * @UseGuards(AuthGuard, RoleGuard)
 * @SubscribeMessage('protected')
 * handleProtected() {
 *   return 'Access granted';
 * }
 *
 * // Using guard instance (pre-configured)
 * @UseGuards(new RoleGuard(['admin', 'moderator']))
 * @SubscribeMessage('admin-only')
 * handleAdminOnly() {
 *   // ...
 * }
 * ```
 */
export function UseGuards(
  ...guards: (Type<CanActivate> | CanActivate)[]
): ClassDecorator & MethodDecorator {
  // No-op if no guards provided
  if (guards.length === 0) {
    return (() => {}) as ClassDecorator & MethodDecorator;
  }

  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor
  ): void | PropertyDescriptor => {
    if (propertyKey) {
      // Method decorator - merge with existing guards and deduplicate
      // For static methods, target is the constructor itself; for instance methods, it's the prototype
      const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;
      const existingGuards: (Type<CanActivate> | CanActivate)[] =
        Reflect.getMetadata(GUARDS_METADATA, metadataTarget, propertyKey) || [];

      Reflect.defineMetadata(
        GUARDS_METADATA,
        [...new Set([...existingGuards, ...guards])],
        metadataTarget,
        propertyKey
      );
      return descriptor;
    } else {
      // Class decorator - merge with existing guards and deduplicate
      const existingGuards: (Type<CanActivate> | CanActivate)[] =
        Reflect.getMetadata(GUARDS_METADATA, target) || [];

      Reflect.defineMetadata(GUARDS_METADATA, [...new Set([...existingGuards, ...guards])], target);
      return;
    }
  };

  return decorator as ClassDecorator & MethodDecorator;
}
