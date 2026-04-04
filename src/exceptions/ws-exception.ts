/**
 * WebSocket exception that can be caught by exception filters
 */
export class WsException extends Error {
  private readonly originalMessage: string | object;

  /**
   * Creates a WebSocket exception
   * @param message - Error message or error object
   * @param error - Optional error type/code
   */
  constructor(
    message: string | object,
    public readonly error?: string
  ) {
    const stringMsg = typeof message === 'string' ? message : WsException.safeStringify(message);
    super(stringMsg);
    this.name = 'WsException';
    this.message = stringMsg;
    this.originalMessage = message;
  }

  /**
   * Gets the error response object
   * @returns Error response with consistent structure
   */
  getError(): { message: string | object; error?: string } {
    return {
      message: this.originalMessage,
      ...(this.error && { error: this.error }),
    };
  }

  /**
   * Safely stringifies an object, handling circular references
   * @param obj - Object to stringify
   * @returns Stringified object or fallback message
   */
  private static safeStringify(obj: object): string {
    try {
      return JSON.stringify(obj);
    } catch (error) {
      // Handle circular references or other serialization errors
      return '[Unserializable object]';
    }
  }
}
