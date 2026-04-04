/**
 * Enhanced WebSocket interface with uWestJS features
 * This wraps the native uWebSockets.js socket with a Socket.IO-like API
 */
export interface UwsSocket {
  /**
   * Unique socket identifier
   */
  readonly id: string;

  /**
   * Custom data attached to the socket
   * Use this to store user information, session data, etc.
   */
  data: any;

  /**
   * Emit an event to this specific client
   * @param event - Event name
   * @param data - Data to send
   * @example
   * ```typescript
   * socket.emit('message', { text: 'Hello!' });
   * ```
   */
  emit(event: string, data: any): void;

  /**
   * Disconnect this client
   * @example
   * ```typescript
   * socket.disconnect();
   * ```
   */
  disconnect(): void;

  /**
   * Get the amount of buffered (backpressured) data for this socket
   * Returns the number of bytes buffered
   * @returns Number of bytes waiting to be sent
   * @example
   * ```typescript
   * const buffered = socket.getBufferedAmount();
   * if (buffered > 1024 * 1024) {
   *   console.log('Client is slow, consider disconnecting');
   * }
   * ```
   */
  getBufferedAmount(): number;

  /**
   * Join one or more rooms
   * @param room - Room name or array of room names
   * @example
   * ```typescript
   * socket.join('room1');
   * socket.join(['room1', 'room2']);
   * ```
   */
  join(room: string | string[]): void;

  /**
   * Leave one or more rooms
   * @param room - Room name or array of room names
   * @example
   * ```typescript
   * socket.leave('room1');
   * socket.leave(['room1', 'room2']);
   * ```
   */
  leave(room: string | string[]): void;

  /**
   * Emit to specific room(s)
   * @param room - Room name or array of room names
   * @returns BroadcastOperator for chaining
   * @example
   * ```typescript
   * socket.to('room1').emit('message', data);
   * socket.to(['room1', 'room2']).emit('message', data);
   * ```
   */
  to(room: string | string[]): BroadcastOperator;

  /**
   * Broadcast operator for sending to multiple clients
   * @example
   * ```typescript
   * socket.broadcast.emit('message', data); // Send to all except this socket
   * socket.broadcast.to('room1').emit('message', data); // Send to room except this socket
   * ```
   */
  readonly broadcast: BroadcastOperator;
}

/**
 * Broadcast operator for sending messages to multiple clients
 */
export interface BroadcastOperator {
  /**
   * Target specific room(s)
   * @param room - Room name or array of room names
   * @returns BroadcastOperator for chaining
   */
  to(room: string | string[]): BroadcastOperator;

  /**
   * Exclude specific client(s)
   * @param clientId - Client ID or array of client IDs to exclude
   * @returns BroadcastOperator for chaining
   */
  except(clientId: string | string[]): BroadcastOperator;

  /**
   * Emit event to all targeted clients
   * @param event - Event name
   * @param data - Data to send
   */
  emit(event: string, data: any): void;
}
