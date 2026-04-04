import 'reflect-metadata';

/**
 * Metadata key for parameter decorators
 * This matches NestJS's internal metadata key for route arguments
 */
export const PARAM_ARGS_METADATA = '__routeArguments__';

/**
 * Parameter type enum
 */
export enum ParamType {
  MESSAGE_BODY = 'messageBody',
  CONNECTED_SOCKET = 'connectedSocket',
  PAYLOAD = 'payload',
}

/**
 * Parameter metadata stored by decorators
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

    const existingParams: ParamMetadata[] =
      Reflect.getMetadata(PARAM_ARGS_METADATA, target.constructor, propertyKey) || [];

    const paramMetadata: ParamMetadata = {
      index: parameterIndex,
      type,
      data,
    };

    existingParams.push(paramMetadata);

    Reflect.defineMetadata(PARAM_ARGS_METADATA, existingParams, target.constructor, propertyKey);
  };
}

/**
 * Decorator that injects the message body/data into a handler parameter
 *
 * @param property - Optional property name to extract from the message data
 *
 * @example
 * ```typescript
 * @SubscribeMessage('chat')
 * handleChat(@MessageBody() data: ChatMessage) {
 *   // data contains the entire message body
 * }
 *
 * @SubscribeMessage('chat')
 * handleChat(@MessageBody('text') text: string) {
 *   // text contains only the 'text' property from message body
 * }
 * ```
 */
export function MessageBody(property?: string): ParameterDecorator {
  return createParamDecorator(ParamType.MESSAGE_BODY, 'MessageBody', property);
}
