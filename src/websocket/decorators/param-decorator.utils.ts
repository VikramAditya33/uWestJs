import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

/**
 * Re-export NestJS's ROUTE_ARGS_METADATA as PARAM_ARGS_METADATA for consistency
 * with our internal naming conventions.
 *
 * @internal
 */
export const PARAM_ARGS_METADATA = ROUTE_ARGS_METADATA;

/**
 * Parameter type enum
 * @internal
 */
export enum ParamType {
  MESSAGE_BODY = 'messageBody',
  CONNECTED_SOCKET = 'connectedSocket',
  PAYLOAD = 'payload',
}

/**
 * Map parameter types to their decorator names for error messages
 * @internal
 */
const PARAM_TYPE_TO_DECORATOR_NAME: Record<ParamType, string> = {
  [ParamType.MESSAGE_BODY]: 'MessageBody',
  [ParamType.CONNECTED_SOCKET]: 'ConnectedSocket',
  [ParamType.PAYLOAD]: 'Payload',
};

/**
 * Parameter metadata stored by decorators
 * @internal
 */
export interface ParamMetadata {
  /**
   * Parameter index in the method signature
   */
  index: number;

  /**
   * Type of parameter (messageBody, connectedSocket, payload)
   */
  type: ParamType;

  /**
   * Optional data passed to the decorator (e.g., property name to extract)
   */
  data?: string;
}

/**
 * Internal helper to create parameter decorators
 * Reduces duplication across decorator implementations
 * @internal
 */
export function createParamDecorator(
  type: ParamType,
  decoratorName: string,
  data?: string
): ParameterDecorator {
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (!propertyKey) {
      throw new Error(`${decoratorName} decorator can only be used on method parameters`);
    }

    // Create a new array to avoid mutating inherited metadata
    const existingParams: ParamMetadata[] = [
      ...(Reflect.getMetadata(PARAM_ARGS_METADATA, target, propertyKey) || []),
    ];

    // Check if this parameter index already has metadata
    const existingIndex = existingParams.findIndex((p) => p.index === parameterIndex);
    if (existingIndex !== -1) {
      const existing = existingParams[existingIndex];
      const existingDecoratorName = PARAM_TYPE_TO_DECORATOR_NAME[existing.type];
      throw new Error(
        `${decoratorName} decorator: parameter at index ${parameterIndex} already has @${existingDecoratorName} decorator applied. ` +
          `Only one parameter decorator is allowed per parameter.`
      );
    }

    const paramMetadata: ParamMetadata = {
      index: parameterIndex,
      type,
      ...(data !== undefined && { data }),
    };

    existingParams.push(paramMetadata);

    Reflect.defineMetadata(PARAM_ARGS_METADATA, existingParams, target, propertyKey);
  };
}
