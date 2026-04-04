/**
 * Base interface for WebSocket client data
 * Extend this interface to add custom client properties
 */
export interface WebSocketClient {
  /**
   * Unique client identifier
   */
  id?: string;

  /**
   * Allow any additional custom properties
   * Use unknown for type safety - requires explicit type checks before use
   * @example
   * ```typescript
   * const client: WebSocketClient = { id: '123', customProp: 'value' };
   * // Need to narrow the type:
   * if (typeof client['customProp'] === 'string') {
   *   console.log(client['customProp'].toUpperCase());
   * }
   * ```
   */
  [key: string]: unknown;
}
