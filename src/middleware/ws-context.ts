/**
 * Base WebSocket execution context
 * Shared structure for guards, filters, and other middleware
 */
export interface WsContext {
  /**
   * The gateway instance
   */
  instance: object;

  /**
   * The method name being executed
   */
  methodName: string;

  /**
   * The WebSocket client
   */
  client: unknown;

  /**
   * The message data
   */
  data: unknown;
}
