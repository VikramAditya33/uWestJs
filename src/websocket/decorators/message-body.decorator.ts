import 'reflect-metadata';
import { ParamType, createParamDecorator } from './param-decorator.utils';

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
  // Normalize empty string to undefined for consistent behavior
  const normalizedProperty = property?.trim() || undefined;
  return createParamDecorator(ParamType.MESSAGE_BODY, 'MessageBody', normalizedProperty);
}
