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
