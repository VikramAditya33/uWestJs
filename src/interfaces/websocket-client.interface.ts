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
   */
  [key: string]: any;
}
