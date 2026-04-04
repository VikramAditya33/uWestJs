import * as uWS from 'uWebSockets.js';
import { UwsSocket, BroadcastOperator } from '../interfaces';
import { WebSocketClient } from '../interfaces';

// Error message for unimplemented room features
const ROOM_NOT_IMPLEMENTED = 'Room management not yet implemented. Coming in Phase 3.';

/**
 * Socket wrapper that provides a Socket.IO-like API over native uWebSockets.js
 * This class wraps the native uWS.WebSocket and adds convenient methods
 */
export class UwsSocketImpl implements UwsSocket {
  private _id: string;
  private _data: any = {};
  private nativeSocket: uWS.WebSocket<WebSocketClient>;

  constructor(id: string, nativeSocket: uWS.WebSocket<WebSocketClient>) {
    this._id = id;
    this.nativeSocket = nativeSocket;
  }

  /**
   * Get the unique socket identifier
   */
  get id(): string {
    return this._id;
  }

  /**
   * Get/set custom data attached to this socket
   * Use this to store user information, session data, etc.
   */
  get data(): any {
    return this._data;
  }

  set data(value: any) {
    this._data = value;
  }

  /**
   * Emit an event to this specific client
   * @param event - Event name
   * @param data - Data to send
   * @example
   * ```typescript
   * socket.emit('message', { text: 'Hello!' });
   * socket.emit('notification', { type: 'info', message: 'Welcome' });
   * ```
   */
  emit(event: string, data: any): void {
    const message = this.serializeMessage(event, data);
    try {
      this.nativeSocket.send(message);
    } catch (error) {
      throw new Error(`Failed to emit event "${event}": ${formatError(error)}`);
    }
  }

  /**
   * Disconnect this client
   * Closes the WebSocket connection
   * @example
   * ```typescript
   * socket.disconnect();
   * ```
   */
  disconnect(): void {
    try {
      this.nativeSocket.close();
    } catch (error) {
      throw new Error(`Failed to disconnect socket ${this._id}: ${formatError(error)}`);
    }
  }

  /**
   * Get the amount of buffered (backpressured) data for this socket
   * Returns the number of bytes buffered
   * @returns Number of bytes waiting to be sent
   * @example
   * ```typescript
   * const buffered = socket.getBufferedAmount();
   * if (buffered > 1024 * 1024) {
   *   console.log('Client is slow, consider disconnecting');
   *   socket.disconnect();
   * }
   * ```
   */
  getBufferedAmount(): number {
    try {
      return this.nativeSocket.getBufferedAmount();
    } catch {
      // If socket is already closed, return 0
      return 0;
    }
  }

  /**
   * Join one or more rooms
   * @param _room - Room name or array of room names
   * @example
   * ```typescript
   * socket.join('room1');
   * socket.join(['room1', 'room2']);
   * ```
   */
  join(_room: string | string[]): void {
    throw new Error(ROOM_NOT_IMPLEMENTED);
  }

  /**
   * Leave one or more rooms
   * @param _room - Room name or array of room names
   * @example
   * ```typescript
   * socket.leave('room1');
   * socket.leave(['room1', 'room2']);
   * ```
   */
  leave(_room: string | string[]): void {
    throw new Error(ROOM_NOT_IMPLEMENTED);
  }

  /**
   * Emit to specific room(s)
   * @param _room - Room name or array of room names
   * @returns BroadcastOperator for chaining
   * @example
   * ```typescript
   * socket.to('room1').emit('message', data);
   * socket.to(['room1', 'room2']).emit('message', data);
   * ```
   */
  to(_room: string | string[]): BroadcastOperator {
    throw new Error(ROOM_NOT_IMPLEMENTED);
  }

  /**
   * Broadcast operator for sending to multiple clients
   * @example
   * ```typescript
   * socket.broadcast.emit('message', data); // Send to all except this socket
   * socket.broadcast.to('room1').emit('message', data); // Send to room except this socket
   * ```
   */
  get broadcast(): BroadcastOperator {
    throw new Error('Broadcast not yet implemented. Coming in Phase 3.');
  }

  /**
   * Get the native uWebSockets.js socket
   * Use this for advanced uWS-specific operations
   * @internal
   */
  getNativeSocket(): uWS.WebSocket<WebSocketClient> {
    return this.nativeSocket;
  }

  /**
   * Serialize event and data to JSON string
   * @private
   */
  private serializeMessage(event: string, data: any): string {
    try {
      return JSON.stringify({ event, data });
    } catch (error) {
      throw new Error(`Failed to emit event "${event}": ${formatError(error)}`);
    }
  }
}

/**
 * Format error for error messages
 * @internal
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
