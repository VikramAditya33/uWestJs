import 'reflect-metadata';
import { ParamType, createParamDecorator } from './param-decorator.utils';

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
  return createParamDecorator(ParamType.CONNECTED_SOCKET, 'ConnectedSocket');
}
