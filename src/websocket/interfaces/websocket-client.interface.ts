/**
 * Base interface for WebSocket client data
 * Extend this interface to add custom client properties
 *
 * @example
 * ```typescript
 * interface MyWebSocketClient extends WebSocketClient {
 *   userId: string;
 *   sessionId: string;
 * }
 * ```
 */
export interface WebSocketClient {
  /**
   * Unique client identifier
   */
  readonly id: string;
}
