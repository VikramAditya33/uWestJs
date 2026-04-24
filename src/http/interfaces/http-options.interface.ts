import { Logger } from '../../shared/interfaces';

/**
 * HTTP-specific options for the uWS platform adapter
 */
export interface HttpOptions {
  /**
   * Maximum request body size in bytes
   *
   * Must be a positive integer. Invalid values (≤ 0, Infinity, or NaN) will throw a validation error at adapter initialization.
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
   *
   * - `false`: do not trust any proxy
   * - `true`: trust all proxies
   * - `number`: trust N hops from the front-facing proxy
   * - `string | string[]`: trust specific IPs, CIDRs, or hostnames
   * - `(ip, hopIndex) => boolean`: custom predicate function
   *
   * @default false
   *
   * @example
   * ```typescript
   * // Trust all proxies
   * trustProxy: true
   *
   * // Trust first proxy only
   * trustProxy: 1
   *
   * // Trust specific IPs
   * trustProxy: ['127.0.0.1', '::1']
   *
   * // Trust CIDR range
   * trustProxy: '10.0.0.0/8'
   *
   * // Custom function
   * trustProxy: (ip, hopIndex) => ip.startsWith('10.')
   * ```
   */
  trustProxy?: boolean | number | string | string[] | ((ip: string, hopIndex: number) => boolean);

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

  /**
   * Fast abort mode for bad requests
   *
   * When enabled, closes connections immediately for requests that exceed size limits
   * or have invalid data, without sending HTTP status codes. This is faster but less
   * user-friendly as clients don't receive proper error responses.
   *
   * **Use cases:**
   * - High-performance APIs where speed is critical
   * - Internal services where clients can handle abrupt closures
   * - DDoS protection (quickly drop malicious requests)
   *
   * **Trade-offs:**
   * - Faster: No time spent formatting/sending error responses
   * - Lower memory: No response buffering for bad requests
   * - Less user-friendly: Clients see connection errors instead of HTTP status codes
   * - Harder to debug: No error messages in client logs
   *
   * @default false
   * @example
   * ```typescript
   * // Enable for maximum performance
   * fastAbort: true
   *
   * // Disable for better developer experience (default)
   * fastAbort: false
   * ```
   */
  fastAbort?: boolean;
}
