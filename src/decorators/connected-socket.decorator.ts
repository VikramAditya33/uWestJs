import 'reflect-metadata';
import { ParamType } from './message-body.decorator';

/**
 * Decorator that injects the connected WebSocket client into a handler parameter
 *
 * @example
 * ```typescript
 * @SubscribeMessage('chat')
 * handleChat(
 *   @ConnectedSocket() client: UwsSocket,
 *   @MessageBody() data: ChatMessage
 * ) {
 *   // client is the WebSocket connection
 *   console.log('Message from client:', client.id);
 * }
 * ```
 */
export function ConnectedSocket(): ParameterDecorator {
  // Import dynamically to avoid circular dependency
  const { createParamDecorator } = require('./message-body.decorator');
  return createParamDecorator(ParamType.CONNECTED_SOCKET, 'ConnectedSocket');
}
