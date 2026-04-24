import type { UwsRequest } from '../../core/request';
import type { UwsResponse } from '../../core/response';
// Note: CorsOptions is imported from shared interfaces because it's part of
// the public adapter configuration API (UwsAdapterOptions.cors), unlike StaticFileOptions
// and CompressionOptions which are only used internally by their respective handlers.
import type { CorsOptions } from '../../../shared/interfaces';

/**
 * Default CORS configuration
 */
const DEFAULT_CORS_OPTIONS = {
  origin: true as boolean, // Allow all origins by default
  credentials: false,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [] as string[],
  maxAge: 86400, // 24 hours
};

/**
 * Normalize string or array to array
 */
function normalizeToArray(value: string | string[] | undefined, defaultValue: string[]): string[] {
  if (value === undefined) return defaultValue;
  return Array.isArray(value) ? value : [value];
}

/**
 * Get first value from string or array
 */
function getFirstValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Handler for CORS (Cross-Origin Resource Sharing) requests
 *
 * Handles both simple requests and preflight (OPTIONS) requests according to
 * the CORS specification.
 *
 * @example
 * ```typescript
 * const corsHandler = new CorsHandler({
 *   origin: 'https://example.com',
 *   credentials: true,
 *   methods: ['GET', 'POST'],
 * });
 *
 * // In request handler
 * const handled = corsHandler.handle(req, res);
 * if (handled) {
 *   return; // Preflight was handled
 * }
 * // Continue with normal request handling
 * ```
 */
export class CorsHandler {
  private readonly options: {
    origin: string | string[] | boolean | ((origin: string | null) => boolean | Promise<boolean>);
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
    exposedHeaders: string[];
    maxAge: number;
  };
  private readonly allowedHeadersExplicitlySet: boolean;

  constructor(options: CorsOptions = {}) {
    // Track if allowedHeaders was explicitly provided (for permissive mode)
    // Treat empty array as "unset" to maintain permissive behavior
    this.allowedHeadersExplicitlySet =
      options.allowedHeaders !== undefined && options.allowedHeaders.length > 0;

    this.options = {
      origin: options.origin ?? DEFAULT_CORS_OPTIONS.origin,
      credentials: options.credentials ?? DEFAULT_CORS_OPTIONS.credentials,
      methods: normalizeToArray(options.methods, DEFAULT_CORS_OPTIONS.methods).map((m) =>
        m.toUpperCase()
      ),
      allowedHeaders: normalizeToArray(options.allowedHeaders, DEFAULT_CORS_OPTIONS.allowedHeaders),
      exposedHeaders: normalizeToArray(options.exposedHeaders, DEFAULT_CORS_OPTIONS.exposedHeaders),
      maxAge: options.maxAge ?? DEFAULT_CORS_OPTIONS.maxAge,
    };
  }

  /**
   * Handle CORS for a request
   *
   * @param req - The request object
   * @param res - The response object
   * @returns Promise that resolves to true if the request was handled (preflight), false otherwise
   */
  async handle(req: UwsRequest, res: UwsResponse): Promise<boolean> {
    // Get origin from request
    const requestOrigin = this.getOrigin(req);

    // Check if origin is allowed
    if (!(await this.isOriginAllowed(requestOrigin))) {
      // Origin not allowed
      // For preflight requests, terminate immediately with 403
      // For normal requests, let them continue (browser will block based on missing CORS headers)
      if (req.method === 'OPTIONS') {
        res.status(403).send();
        return true; // Request was handled
      }
      return false; // Let normal request continue without CORS headers
    }

    // Handle preflight request (OPTIONS) - validate before setting headers
    if (req.method === 'OPTIONS') {
      return this.handlePreflight(req, res, requestOrigin);
    }

    // For normal requests, set CORS headers
    // Set Access-Control-Allow-Origin
    this.setOriginHeader(res, requestOrigin);

    // Set Access-Control-Allow-Credentials if enabled
    if (this.options.credentials) {
      res.setHeader('access-control-allow-credentials', 'true');
    }

    // Set Access-Control-Expose-Headers if specified
    if (this.options.exposedHeaders.length > 0) {
      res.setHeader('access-control-expose-headers', this.options.exposedHeaders.join(', '));
    }

    // Not a preflight request, continue with normal handling
    return false;
  }

  /**
   * Handle preflight (OPTIONS) request
   *
   * @param req - The request object
   * @param res - The response object
   * @param requestOrigin - The origin from the request
   * @returns true (preflight was handled)
   */
  private handlePreflight(
    req: UwsRequest,
    res: UwsResponse,
    requestOrigin: string | null
  ): boolean {
    // Validate Access-Control-Request-Method (defense-in-depth)
    const requestedMethod = getFirstValue(req.headers['access-control-request-method']);
    if (requestedMethod) {
      const methodUpper = requestedMethod.toUpperCase();
      if (!this.options.methods.includes(methodUpper)) {
        // Requested method not allowed - reject preflight
        res.status(403).send();
        return true;
      }
    }

    // Validate Access-Control-Request-Headers if explicitly configured
    const requestedHeaders = getFirstValue(req.headers['access-control-request-headers']);
    let allowedHeadersToSend: string;

    if (requestedHeaders && this.allowedHeadersExplicitlySet) {
      // User explicitly configured allowedHeaders - validate requested headers
      const requested = requestedHeaders.split(',').map((h) => h.trim().toLowerCase());
      const allowed = this.options.allowedHeaders.map((h) => h.toLowerCase());
      const validated = requested.filter((h) => allowed.includes(h));

      if (validated.length === 0) {
        // Requested headers not allowed - reject preflight
        res.status(403).send();
        return true;
      }
      allowedHeadersToSend = validated.join(', ');
    } else if (requestedHeaders) {
      // No allowedHeaders configured or empty array - echo back (permissive mode)
      allowedHeadersToSend = requestedHeaders;
    } else if (this.allowedHeadersExplicitlySet) {
      // No requested headers but allowedHeaders explicitly configured - use configured
      allowedHeadersToSend = this.options.allowedHeaders.join(', ');
    } else {
      // No requested headers and no explicit config - use defaults
      allowedHeadersToSend = DEFAULT_CORS_OPTIONS.allowedHeaders.join(', ');
    }

    // All validations passed - set CORS headers
    // Set Access-Control-Allow-Origin
    this.setOriginHeader(res, requestOrigin);

    // Set Access-Control-Allow-Credentials if enabled
    if (this.options.credentials) {
      res.setHeader('access-control-allow-credentials', 'true');
    }

    // Set Access-Control-Expose-Headers if specified
    if (this.options.exposedHeaders.length > 0) {
      res.setHeader('access-control-expose-headers', this.options.exposedHeaders.join(', '));
    }

    // Set Access-Control-Allow-Methods
    res.setHeader('access-control-allow-methods', this.options.methods.join(', '));

    // Set Access-Control-Allow-Headers
    res.setHeader('access-control-allow-headers', allowedHeadersToSend);

    // Set Access-Control-Max-Age
    res.setHeader('access-control-max-age', this.options.maxAge.toString());

    // Send 204 No Content response
    res.status(204).send();

    return true; // Preflight was handled
  }

  /**
   * Get origin from request headers
   *
   * @param req - The request object
   * @returns The origin or null
   */
  private getOrigin(req: UwsRequest): string | null {
    return getFirstValue(req.headers['origin']);
  }

  /**
   * Check if origin is allowed
   *
   * @param origin - The origin to check
   * @returns Promise that resolves to true if allowed, false otherwise
   */
  private async isOriginAllowed(origin: string | null): Promise<boolean> {
    const { origin: allowedOrigin } = this.options;

    // Boolean: true = allow all, false = deny all
    // Handle this first so origin: false can deny no-origin requests
    if (typeof allowedOrigin === 'boolean') {
      return allowedOrigin;
    }

    // Function: dynamic validation (sync or async) — user decides null policy
    // Note: Errors are intentionally NOT caught here - they indicate bugs in user code
    // that should be surfaced rather than silently converted to "deny". This follows
    // the fail-fast principle and matches behavior of Express CORS and similar middleware.
    if (typeof allowedOrigin === 'function') {
      return await allowedOrigin(origin);
    }

    // For string/array configs, no Origin header means same-origin/non-browser — allow
    if (!origin) {
      return true;
    }

    // String: exact match
    if (typeof allowedOrigin === 'string') {
      return allowedOrigin === '*' || allowedOrigin === origin;
    }

    // Array: check if origin is in the list
    if (Array.isArray(allowedOrigin)) {
      return allowedOrigin.includes(origin);
    }

    // Exhaustiveness check - TypeScript will error if a new type is added to origin
    const _exhaustive: never = allowedOrigin;
    return _exhaustive;
  }

  /**
   * Set Access-Control-Allow-Origin header
   *
   * @param res - The response object
   * @param origin - The request origin
   */
  private setOriginHeader(res: UwsResponse, origin: string | null): void {
    const { origin: allowedOrigin, credentials } = this.options;

    // Determine if we should echo the origin (instead of using '*')
    const shouldEchoOrigin =
      credentials || typeof allowedOrigin === 'function' || Array.isArray(allowedOrigin);

    // If we should echo origin and have one, use it with Vary header
    if (shouldEchoOrigin && origin) {
      res.setHeader('access-control-allow-origin', origin);

      // Append to existing Vary header if present (per HTTP spec, multiple values are comma-separated)
      const existingVary = res.getHeader('vary');
      if (existingVary) {
        const varyValue = typeof existingVary === 'string' ? existingVary : existingVary.join(', ');
        // Parse comma-separated tokens and check if Origin is already present
        const varyTokens = varyValue.split(',').map((v) => v.trim().toLowerCase());
        if (!varyTokens.includes('origin')) {
          res.setHeader('vary', `${varyValue}, Origin`);
        }
      } else {
        res.setHeader('vary', 'Origin');
      }

      return;
    }

    // Credentials mode but no origin to echo
    // Emitting '*' would be spec-invalid when combined with Access-Control-Allow-Credentials: true
    // Skip ACAO entirely to avoid the violation
    if (credentials) {
      return;
    }

    // Use wildcard for boolean true or '*' string
    if (allowedOrigin === '*' || allowedOrigin === true) {
      res.setHeader('access-control-allow-origin', '*');
      return;
    }

    // Use specific string origin
    if (typeof allowedOrigin === 'string') {
      res.setHeader('access-control-allow-origin', allowedOrigin);
      return;
    }

    // Default: allow all with wildcard
    // Reached when allowedOrigin is function/array with no origin to echo
    // (e.g., function validator with null origin, or array validator with null origin)
    // Design choice: Null-origin requests (same-origin or non-browser) receive wildcard
    // treatment when using function/array configs, since they're already allowed by
    // isOriginAllowed and don't pose CORS security risks (no Origin header = no CORS)
    res.setHeader('access-control-allow-origin', '*');
  }
}
