import 'reflect-metadata';
import { ParamType } from './message-body.decorator';

/**
 * Decorator that injects the message payload/data into a handler parameter
 * This is an alias for @MessageBody() for compatibility with NestJS WebSocket patterns
 *
 * @param property - Optional property name to extract from the payload
 *
 * @example
 * ```typescript
 * @SubscribeMessage('chat')
 * handleChat(@Payload() data: ChatMessage) {
 *   // data contains the entire payload
 * }
 *
 * @SubscribeMessage('chat')
 * handleChat(@Payload('message') message: string) {
 *   // message contains only the 'message' property from payload
 * }
 * ```
 */
export function Payload(property?: string): ParameterDecorator {
  // Import dynamically to avoid circular dependency
  const { createParamDecorator } = require('./message-body.decorator');
  return createParamDecorator(ParamType.PAYLOAD, 'Payload', property);
}
