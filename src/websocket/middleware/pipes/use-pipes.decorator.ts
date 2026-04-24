import { PipeTransform, Type } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply pipes to a class, method, or parameter
 * Pipes transform and validate data before it reaches the handler
 *
 * @param pipes - Pipe classes or instances to apply
 *
 * @example
 * ```typescript
 * // Method-level pipes using class (resolved from DI)
 * @UsePipes(ValidationPipe)
 * @SubscribeMessage('create')
 * handleCreate(@MessageBody() data: CreateDto) {
 *   return data;
 * }
 *
 * // Parameter-level pipes using instance (pre-configured)
 * @SubscribeMessage('update')
 * handleUpdate(@UsePipes(new ValidationPipe({ transform: true })) @MessageBody() data: UpdateDto) {
 *   return data;
 * }
 * ```
 */
export function UsePipes(
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ClassDecorator & MethodDecorator & ParameterDecorator {
  // No-op if no pipes provided
  if (pipes.length === 0) {
    return (() => {}) as ClassDecorator & MethodDecorator & ParameterDecorator;
  }

  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptorOrIndex?: PropertyDescriptor | number
  ): void | PropertyDescriptor => {
    // For static methods, target is the constructor itself; for instance methods, it's the prototype
    const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;

    if (typeof descriptorOrIndex === 'number') {
      // Parameter decorator
      if (propertyKey === undefined) {
        throw new Error(
          'UsePipes cannot be applied to constructor parameters. ' +
            'Use it on method parameters instead.'
        );
      }

      const existingPipes: Map<number, (Type<PipeTransform> | PipeTransform)[]> =
        Reflect.getMetadata(`${PIPES_METADATA}:params`, metadataTarget, propertyKey) || new Map();

      const paramPipes = existingPipes.get(descriptorOrIndex) || [];
      // Deduplicate pipes to prevent redundant execution
      const mergedPipes = [...new Set([...paramPipes, ...pipes])];
      existingPipes.set(descriptorOrIndex, mergedPipes);

      Reflect.defineMetadata(
        `${PIPES_METADATA}:params`,
        existingPipes,
        metadataTarget,
        propertyKey
      );
    } else if (propertyKey) {
      // Method decorator - merge with existing pipes and deduplicate
      const existingPipes: (Type<PipeTransform> | PipeTransform)[] =
        Reflect.getMetadata(PIPES_METADATA, metadataTarget, propertyKey) || [];

      Reflect.defineMetadata(
        PIPES_METADATA,
        [...new Set([...existingPipes, ...pipes])],
        metadataTarget,
        propertyKey
      );
      return descriptorOrIndex;
    } else {
      // Class decorator - merge with existing pipes and deduplicate
      const existingPipes: (Type<PipeTransform> | PipeTransform)[] =
        Reflect.getMetadata(PIPES_METADATA, target) || [];

      Reflect.defineMetadata(PIPES_METADATA, [...new Set([...existingPipes, ...pipes])], target);
    }
  };

  return decorator as ClassDecorator & MethodDecorator & ParameterDecorator;
}
