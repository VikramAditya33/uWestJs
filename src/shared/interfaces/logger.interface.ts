/**
 * Logger interface for framework logging
 * Allows users to integrate with their preferred logging solution
 */
export interface Logger {
  /**
   * Log an error message
   * @param message - Error message
   * @param context - Optional error context (commonly Error object, stack trace string, or structured metadata)
   */
  error(message: string, context?: unknown): void;

  /**
   * Log a warning message
   * @param message - Warning message
   * @param context - Optional warning context (commonly structured metadata or additional details)
   */
  warn?(message: string, context?: unknown): void;

  /**
   * Log an info message
   * @param message - Info message
   * @param context - Optional info context (commonly structured metadata or additional details)
   */
  log?(message: string, context?: unknown): void;

  /**
   * Log a debug message
   * @param message - Debug message
   * @param context - Optional debug context (commonly structured metadata or additional details)
   */
  debug?(message: string, context?: unknown): void;
}
