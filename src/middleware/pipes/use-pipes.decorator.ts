import { PipeTransform, Type } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Decorator to apply pipes to a class, method, or parameter
 * Pipes transform and validate data before it reaches the handler
 *
 * @param pipes - Pipe classes to apply
 *
 * @example
 * ```typescript
 * // Method-level pipes
 * @UsePipes(ValidationPipe)
 * @SubscribeMessage('create')
 * handleCreate(@MessageBody() data: CreateDto) {
 *   return data;
 * }
 *
 * // Parameter-level pipes
 * @SubscribeMessage('update')
 * handleUpdate(@UsePipes(ValidationPipe) @MessageBody() data: UpdateDto) {
 *   return data;
 * }
 * ```
 */
export function UsePipes(
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): ClassDecorator & MethodDecorator & ParameterDecorator {
  const pipeTypes = pipes.map((pipe) =>
    typeof pipe === 'function' ? pipe : (pipe.constructor as Type<PipeTransform>)
  );

  const decorator = (
    target: object | ((...args: unknown[]) => unknown),
    propertyKey?: string | symbol,
    descriptorOrIndex?: PropertyDescriptor | number
  ): void | PropertyDescriptor => {
    // For static methods, target is the constructor itself; for instance methods, it's the prototype
    const metadataTarget = typeof target === 'function' ? target : (target as object).constructor;

    if (typeof descriptorOrIndex === 'number') {
      // Parameter decorator
      const existingPipes: Map<number, Type<PipeTransform>[]> =
        Reflect.getMetadata(
          `${PIPES_METADATA}:params`,
          metadataTarget,
          propertyKey!
        ) || new Map();

      const paramPipes = existingPipes.get(descriptorOrIndex) || [];
      paramPipes.push(...pipeTypes);
      existingPipes.set(descriptorOrIndex, paramPipes);

      Reflect.defineMetadata(
        `${PIPES_METADATA}:params`,
        existingPipes,
        metadataTarget,
        propertyKey!
      );
    } else if (propertyKey) {
      // Method decorator - merge with existing pipes
      const existingPipes: Type<PipeTransform>[] =
        Reflect.getMetadata(PIPES_METADATA, metadataTarget, propertyKey) || [];
      
      Reflect.defineMetadata(
        PIPES_METADATA,
        [...existingPipes, ...pipeTypes],
        metadataTarget,
        propertyKey
      );
      return descriptorOrIndex;
    } else {
      // Class decorator
      Reflect.defineMetadata(PIPES_METADATA, pipeTypes, target);
    }
  };

  return decorator as ClassDecorator & MethodDecorator & ParameterDecorator;
}
