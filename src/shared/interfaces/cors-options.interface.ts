/**
 * CORS configuration options
 * Supports both HTTP and WebSocket CORS
 */
export interface CorsOptions {
  /**
   * Allowed origins
   * - string: single origin (e.g., 'https://example.com') or '*' for all origins
   * - string[]: multiple origins
   * - boolean: true = allow all origins (equivalent to '*'), false = deny all
   * - function: dynamic origin validation (sync or async)
   *
   * Note: Both '*' (string) and true (boolean) allow all origins and are functionally equivalent.
   * The origin parameter can be null in privacy-sensitive contexts (sandboxed iframes, local files).
   *
   * Security Warning: Wildcard origins ('*' or true) CANNOT be combined with credentials: true.
   * Browsers will reject this combination per the CORS specification to prevent credential leakage.
   *
   * @example 'https://example.com' | ['https://example.com', 'https://app.example.com'] | '*' | true | false
   */
  origin?: string | string[] | boolean | ((origin: string | null) => boolean | Promise<boolean>);

  /**
   * Allow credentials (cookies, authorization headers, TLS client certificates)
   * @default false
   */
  credentials?: boolean;

  /**
   * Allowed HTTP methods for CORS preflight
   *
   * When not specified, the platform adapter applies context-appropriate defaults:
   * - HTTP context: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']
   * - WebSocket context: ['GET', 'POST']
   *
   * Explicitly setting this field overrides the default for all contexts.
   *
   * @default Context-dependent (see above)
   */
  methods?: string | string[];

  /**
   * Headers that clients are allowed to send
   * @default ['Content-Type', 'Authorization']
   */
  allowedHeaders?: string | string[];

  /**
   * Headers that are exposed to the client
   * @default []
   */
  exposedHeaders?: string | string[];

  /**
   * How long (in seconds) the results of a preflight request can be cached
   * @default 86400 (24 hours)
   */
  maxAge?: number;
}
