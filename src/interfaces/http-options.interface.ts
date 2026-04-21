/**
 * Logger interface for framework logging
 * Allows users to integrate with their preferred logging solution
 */
export interface Logger {
  /**
   * Log an error message
   * @param message - Error message
   * @param context - Optional error context or stack trace
   */
  error(message: string, context?: unknown): void;

  /**
   * Log a warning message
   * @param message - Warning message
   * @param context - Optional warning context
   */
  warn?(message: string, context?: unknown): void;

  /**
   * Log an info message
   * @param message - Info message
   * @param context - Optional info context
   */
  log?(message: string, context?: unknown): void;

  /**
   * Log a debug message
   * @param message - Debug message
   * @param context - Optional debug context
   */
  debug?(message: string, context?: unknown): void;
}

/**
 * HTTP-specific options for the uWS platform adapter
 */
export interface HttpOptions {
  /**
   * Maximum request body size in bytes
   *
   * Must be a positive integer. Values <= 0, Infinity, or NaN will cause undefined behavior.
   *
   * @default 1048576 (1MB)
   * @example
   * ```typescript
   * maxBodySize: 10 * 1024 * 1024  // 10MB
   * maxBodySize: 100 * 1024        // 100KB
   * ```
   */
  maxBodySize?: number;

  /**
   * Logger instance for framework logging
   *
   * Allows integration with custom logging solutions (Winston, Pino, etc.).
   * If not provided, defaults to console logging.
   *
   * @default console
   * @example
   * ```typescript
   * // Using Winston
   * logger: {
   *   error: (message, context) => winston.error(message, context),
   *   warn: (message, context) => winston.warn(message, context),
   * }
   *
   * // Using Pino
   * logger: {
   *   error: (message, context) => pino.error(context, message),
   * }
   * ```
   */
  logger?: Logger;

  /**
   * Body parser configuration
   */
  bodyParser?: {
    /**
     * Enable JSON body parsing
     * @default true
     */
    json?: boolean;

    /**
     * Enable URL-encoded body parsing
     * @default true
     */
    urlencoded?: boolean;

    /**
     * Enable raw body parsing
     * @default false
     */
    raw?: boolean;

    /**
     * Enable text body parsing
     * @default false
     */
    text?: boolean;
  };

  /**
   * Trust proxy headers (X-Forwarded-*)
   * @default false
   */
  trustProxy?: boolean;

  /**
   * ETag generation
   *
   * When omitted, defaults to 'weak' at runtime.
   *
   * - `false`: disabled
   * - `'weak'`: weak ETags (default)
   * - `'strong'`: strong ETags
   *
   * @default 'weak'
   */
  etag?: false | 'weak' | 'strong';
}
