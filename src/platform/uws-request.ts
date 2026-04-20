import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { BodyParser } from './body-parser';
import * as cookie from 'cookie';
import * as signature from 'cookie-signature';

/**
 * Headers that should NOT be duplicated per HTTP spec
 * @see https://www.rfc-editor.org/rfc/rfc7230#section-3.2.2
 */
const DISCARDED_DUPLICATES = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
]);

/**
 * HTTP Request wrapper for uWebSockets.js
 *
 * CRITICAL: uWS.HttpRequest is stack-allocated and MUST be cached immediately in constructor.
 * All data from uwsReq must be extracted synchronously before the constructor returns.
 * After the constructor completes, the uwsReq object is deallocated by uWS and cannot be accessed.
 *
 * This implementation uses lazy evaluation for headers and query parameters to optimize performance.
 * Headers are only parsed when first accessed, and the parsed result is cached for subsequent access.
 *
 * **Body Parsing**: Unlike Express where req.body is synchronous (populated by middleware),
 * body parsing methods (buffer(), json(), text(), urlencoded()) return Promises because
 * uWebSockets.js streams body data asynchronously. The body getter also returns a Promise.
 * In NestJS applications, use parameter decorators (@Body(), @Req()) instead of direct access.
 */
export class UwsRequest {
  // Core properties (cached from stack-allocated uWS request)
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: string;
  readonly originalUrl: string;

  // Raw header entries (cached immediately)
  private readonly rawHeadersEntries: Array<[string, string]> = [];

  // Lazy-loaded properties
  private cachedHeaders?: Record<string, string | string[]>;
  private cachedQueryParams?: Record<string, string | string[]>;
  private cachedParams?: Record<string, string>;
  private cachedCookies?: Record<string, string>;

  // Cookie secret for Express-compatible signedCookies property
  private cookieSecret?: string;

  // Reference to response (for body parsing later)
  private readonly uwsRes: HttpResponse;

  // Body parsing
  private bodyParser?: BodyParser;
  private cachedBody?: Buffer;
  private cachedJson?: unknown;
  private cachedText?: string;
  private cachedUrlencoded?: Record<string, unknown>;

  // Promise caching for body parsing
  private bufferPromise?: Promise<Buffer>;
  private jsonPromise?: Promise<unknown>;
  private textPromise?: Promise<string>;
  private urlencodedPromise?: Promise<Record<string, unknown>>;
  /**
   * Creates a new UwsRequest instance
   *
   * @param uwsReq - Stack-allocated uWS.HttpRequest (MUST cache immediately)
   * @param uwsRes - uWS.HttpResponse (for body parsing)
   * @param paramNames - Optional array of parameter names for route params
   */
  constructor(uwsReq: HttpRequest, uwsRes: HttpResponse, paramNames?: string[] | undefined) {
    // CRITICAL: Cache ALL data from stack-allocated uwsReq immediately
    // After constructor returns, uwsReq will be deallocated by uWS

    // Cache method (uppercase for consistency)
    this.method = uwsReq.getMethod().toUpperCase();

    // Cache URL components
    // Note: getUrl() returns path WITHOUT query string, getQuery() returns query WITHOUT '?'
    const urlPath = uwsReq.getUrl();
    const queryString = uwsReq.getQuery() || '';

    this.url = urlPath;
    this.path = urlPath; // getUrl() already returns path without query string
    this.query = queryString;
    this.originalUrl = queryString ? `${urlPath}?${queryString}` : urlPath;

    // Cache headers immediately (uWS.HttpRequest.forEach is synchronous)
    uwsReq.forEach((key, value) => {
      this.rawHeadersEntries.push([key, value]);
    });

    // Cache path parameters if provided
    if (paramNames && paramNames.length > 0) {
      this.cacheParams(uwsReq, paramNames);
    }

    // Store response reference for body parsing
    this.uwsRes = uwsRes;
  }

  /**
   * Get all headers (lazy evaluation)
   *
   * Follows HTTP/1.1 specification (RFC 7230) for duplicate header handling:
   * - Most headers: concatenate with ', ' (comma-space)
   * - Cookie: concatenate with '; ' (semicolon-space) per RFC 6265
   * - Set-Cookie: must be array (cannot be concatenated)
   * - Certain headers: discard duplicates (content-length, authorization, etc.)
   *
   * Headers are parsed on first access and cached for performance.
   */
  get headers(): Record<string, string | string[]> {
    if (this.cachedHeaders) {
      return this.cachedHeaders;
    }

    this.cachedHeaders = {};

    for (const [key, value] of this.rawHeadersEntries) {
      const lowerKey = key.toLowerCase();

      if (this.cachedHeaders[lowerKey]) {
        // Header already exists - handle duplicates per HTTP spec

        if (DISCARDED_DUPLICATES.has(lowerKey)) {
          // Discard duplicate per HTTP spec
          continue;
        }

        if (lowerKey === 'cookie') {
          // Cookies concatenate with '; ' per RFC 6265
          this.cachedHeaders[lowerKey] += '; ' + value;
        } else if (lowerKey === 'set-cookie') {
          // Set-Cookie must be array (can't concatenate)
          if (!Array.isArray(this.cachedHeaders[lowerKey])) {
            this.cachedHeaders[lowerKey] = [this.cachedHeaders[lowerKey] as string];
          }
          (this.cachedHeaders[lowerKey] as string[]).push(value);
        } else {
          // Other headers concatenate with ', ' per HTTP spec
          this.cachedHeaders[lowerKey] += ', ' + value;
        }
      } else {
        // First occurrence
        this.cachedHeaders[lowerKey] = lowerKey === 'set-cookie' ? [value] : value;
      }
    }

    return this.cachedHeaders;
  }

  /**
   * Get parsed query parameters (lazy evaluation)
   */
  get queryParams(): Record<string, string | string[]> {
    if (!this.cachedQueryParams) {
      this.cachedQueryParams = this.parseQuery(this.query);
    }
    return this.cachedQueryParams;
  }

  /**
   * Get path parameters
   */
  get params(): Record<string, string> {
    return this.cachedParams || {};
  }

  /**
   * Get parsed cookies (lazy evaluation)
   *
   * Parses the Cookie header and returns an object of cookie name-value pairs.
   * Cookies are parsed on first access and cached for performance.
   *
   * @returns Object containing cookie name-value pairs
   *
   * @example
   * ```typescript
   * // Cookie header: "session=abc123; user=vikram"
   * const cookies = req.cookies;
   * console.log(cookies.session); // "abc123"
   * console.log(cookies.user); // "vikram"
   * ```
   */
  get cookies(): Record<string, string> {
    if (this.cachedCookies) {
      return this.cachedCookies;
    }

    const cookieHeader = this.headers['cookie'];
    if (!cookieHeader) {
      this.cachedCookies = {};
      return this.cachedCookies;
    }

    // Cookie header is always a string (never array)
    const cookieString = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
    const parsed = cookie.parse(cookieString);

    // Filter out undefined values (cookie.parse can return undefined for malformed cookies)
    this.cachedCookies = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        this.cachedCookies[key] = value;
      }
    }

    return this.cachedCookies;
  }

  /**
   * Get parsed signed cookies (Express-compatible property)
   *
   * Returns signed cookies using the secret set via _setCookieSecret().
   * This is the Express-compatible API that works with cookie-parser middleware pattern.
   *
   * If no secret is set, returns an empty object.
   *
   * @returns Object containing signed cookie name-value pairs
   *
   * @example
   * ```typescript
   * // Set secret (typically done by middleware or platform)
   * req._setCookieSecret('my-secret');
   *
   * // Access signed cookies (Express-compatible)
   * const cookies = req.signedCookies;
   * console.log(cookies.session); // "abc123" (if signature is valid)
   * ```
   */
  get signedCookies(): Record<string, string> {
    if (!this.cookieSecret) {
      return {};
    }
    return this.getSignedCookies(this.cookieSecret);
  }

  /**
   * Get parsed signed cookies with explicit secret (method API)
   *
   * Parses signed cookies and verifies their signatures.
   * Supports two formats for backward compatibility:
   * - Express format: 's:value.signature' (with 's:' prefix)
   * - Direct format: 'value.signature' (without prefix)
   *
   * Only returns cookies with valid signatures.
   *
   * This is an alternative API that allows passing the secret explicitly,
   * useful for advanced use cases like multi-tenant applications.
   *
   * Note: This method does not cache results because the secret parameter may vary.
   * However, it's typically called only once per request, so performance impact is minimal.
   *
   * @param secret - Secret key used to sign cookies
   * @returns Object containing signed cookie name-value pairs
   *
   * @example
   * ```typescript
   * // Explicit secret (useful for multi-tenant scenarios)
   * const cookies = req.getSignedCookies('my-secret');
   * console.log(cookies.session); // "abc123" (if signature is valid)
   * ```
   */
  getSignedCookies(secret: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(this.cookies)) {
      // Handle both formats: 's:value.signature' and 'value.signature'
      const signedValue = value.startsWith('s:') ? value.slice(2) : value;
      const unsigned = signature.unsign(signedValue, secret);

      if (unsigned !== false) {
        result[name] = unsigned;
      }
    }

    return result;
  }

  /**
   * Set cookie secret for signed cookies
   *
   * This is typically called by middleware or the platform adapter to set
   * the secret used for the Express-compatible signedCookies property.
   *
   * @param secret - Secret key used to sign cookies
   * @internal
   */
  _setCookieSecret(secret: string): void {
    this.cookieSecret = secret;
  }

  /**
   * Get a specific header value (case-insensitive)
   *
   * @param name - Header name
   * @returns Header value or undefined
   */
  get(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   * Alias for get() - Express compatibility
   *
   * @param name - Header name
   * @returns Header value or undefined
   */
  header(name: string): string | string[] | undefined {
    return this.get(name);
  }

  /**
   * Cache path parameters from uWS.HttpRequest
   *
   * @param uwsReq - Stack-allocated uWS.HttpRequest
   * @param paramNames - Array of parameter names
   */
  private cacheParams(uwsReq: HttpRequest, paramNames: string[]): void {
    this.cachedParams = {};

    for (let i = 0; i < paramNames.length; i++) {
      const paramName = paramNames[i];
      const paramValue = uwsReq.getParameter(i);
      if (paramValue !== undefined) {
        this.cachedParams[paramName] = paramValue;
      }
    }
  }

  /**
   * Set path parameters (used by route registry for pattern matching)
   *
   * This is an internal API used by RouteRegistry to set extracted parameters
   * from route pattern matching. Not intended for public use.
   *
   * @internal
   * @param params - Extracted route parameters
   */
  _setParams(params: Record<string, string>): void {
    this.cachedParams = params;
  }

  /**
   * Parse query string into object
   *
   * Used for both URL query parameters and application/x-www-form-urlencoded body data.
   * Provides consistent parsing behavior across the class.
   *
   * Handles edge cases:
   * - Values containing '=' (e.g., key=val=ue → {key: 'val=ue'})
   * - Malformed URI encoding (e.g., %ZZ → uses raw value)
   * - Array parameters (key=val1&key=val2 → {key: ['val1', 'val2']})
   *
   * @param queryString - Raw query string (without '?')
   * @returns Parsed query parameters
   */
  private parseQuery(queryString: string): Record<string, string | string[]> {
    if (!queryString) {
      return {};
    }

    const params: Record<string, string | string[]> = {};
    const pairs = queryString.split('&');

    for (const pair of pairs) {
      // Use indexOf to handle values containing '='
      const eqIndex = pair.indexOf('=');
      const key = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
      const value = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);

      if (!key) continue;

      // Decode with error handling for malformed URI encoding
      // Note: Replace + with space before decoding (application/x-www-form-urlencoded standard)
      let decodedKey: string;
      let decodedValue: string;
      try {
        decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
        decodedValue = value ? decodeURIComponent(value.replace(/\+/g, ' ')) : '';
      } catch {
        // Malformed URI encoding - use raw values (still replace + with space)
        decodedKey = key.replace(/\+/g, ' ');
        decodedValue = value ? value.replace(/\+/g, ' ') : '';
      }

      // Handle array parameters (key[]=value or key=value1&key=value2)
      const existing = params[decodedKey];
      if (existing !== undefined) {
        if (Array.isArray(existing)) {
          existing.push(decodedValue);
        } else {
          params[decodedKey] = [existing, decodedValue];
        }
      } else {
        params[decodedKey] = decodedValue;
      }
    }

    return params;
  }

  /**
   * Get content type header
   */
  get contentType(): string | undefined {
    const ct = this.get('content-type');
    return Array.isArray(ct) ? ct[0] : ct;
  }

  /**
   * Get content length header
   *
   * Per RFC 7230, Content-Length must contain only decimal digits.
   * Rejects invalid values like "10abc", "10.5", "1e3", negative numbers, and unsafe integers.
   */
  get contentLength(): number | undefined {
    const cl = this.get('content-length');
    const value = Array.isArray(cl) ? cl[0] : cl;
    if (!value) return undefined;

    const trimmed = value.trim();
    // RFC 7230: Content-Length must be decimal digits only
    if (!/^\d+$/.test(trimmed)) return undefined;

    const parsed = Number(trimmed);
    // Reject unsafe integers (beyond Number.MAX_SAFE_INTEGER)
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  /**
   * Check if request is for a specific content type
   *
   * Supports multiple matching patterns:
   * - Full MIME type: is('application/json')
   * - Subtype only: is('json') matches 'application/json' and 'application/vnd.api+json'
   * - Type prefix: is('text') matches 'text/plain', 'text/html', etc.
   *
   * Handles structured syntax suffixes per RFC 6839 (e.g., +json, +xml).
   *
   * @param type - MIME type or pattern to check
   * @returns true if content-type matches
   */
  is(type: string): boolean {
    const ct = this.contentType;
    if (!ct) return false;

    // Strip charset and parameters (e.g., "application/json; charset=utf-8" -> "application/json")
    const normalizedCt = ct.toLowerCase().split(';')[0].trim();
    const normalizedType = type.toLowerCase().trim();

    // Exact match (e.g., is('application/json'))
    if (normalizedCt === normalizedType) {
      return true;
    }

    // Subtype match (e.g., is('json') matches 'application/json' and 'application/vnd.api+json')
    // Supports both exact subtype and structured syntax suffixes (RFC 6839)
    const subtype = normalizedCt.split('/')[1] ?? '';
    if (subtype === normalizedType || subtype.endsWith(`+${normalizedType}`)) {
      return true;
    }

    // Type prefix match (e.g., is('text') matches 'text/plain', 'text/html')
    if (normalizedCt.startsWith(normalizedType + '/')) {
      return true;
    }

    return false;
  }

  /**
   * Initialize body parser (called by platform adapter)
   *
   * This must be called synchronously during request handling setup,
   * before any async operations, to ensure the onData handler is registered.
   *
   * @param maxBodySize - Maximum body size in bytes
   * @internal
   */
  _initBodyParser(maxBodySize: number): void {
    this.bodyParser = new BodyParser(this.uwsRes, this.headers, maxBodySize);
  }

  /**
   * Get raw body as Buffer
   *
   * This method buffers the entire request body into memory.
   * For large bodies, consider using streaming instead (future implementation).
   *
   * @returns Promise that resolves with the complete body buffer
   */
  async buffer(): Promise<Buffer> {
    // Return cached result if available
    if (this.cachedBody) {
      return this.cachedBody;
    }

    // Return existing promise if buffer() was already called
    if (this.bufferPromise) {
      return this.bufferPromise;
    }

    // No body parser initialized - return empty buffer
    if (!this.bodyParser) {
      return Buffer.alloc(0);
    }

    // Create and cache the promise
    this.bufferPromise = this.bodyParser.buffer().then((buffer) => {
      this.cachedBody = buffer;
      return buffer;
    });

    return this.bufferPromise;
  }

  /**
   * Parse body as JSON
   *
   * Caches the parsed result for subsequent calls.
   *
   * @returns Promise that resolves with the parsed JSON object
   * @throws Error if body is not valid JSON
   */
  async json<T = unknown>(): Promise<T> {
    // Return cached result if available
    if (this.cachedJson !== undefined) {
      return this.cachedJson as T;
    }

    // Return existing promise if json() was already called
    if (this.jsonPromise) {
      return this.jsonPromise as Promise<T>;
    }

    // Create and cache the promise
    this.jsonPromise = this.buffer().then((buffer) => {
      const text = buffer.toString('utf-8');

      try {
        this.cachedJson = JSON.parse(text) as T;
      } catch (e) {
        throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        });
      }

      return this.cachedJson as T;
    });

    return this.jsonPromise as Promise<T>;
  }

  /**
   * Parse body as text
   *
   * Caches the result for subsequent calls.
   *
   * @returns Promise that resolves with the body as UTF-8 string
   */
  async text(): Promise<string> {
    // Return cached result if available
    if (this.cachedText !== undefined) {
      return this.cachedText;
    }

    // Return existing promise if text() was already called
    if (this.textPromise) {
      return this.textPromise;
    }

    // Create and cache the promise
    this.textPromise = this.buffer().then((buffer) => {
      this.cachedText = buffer.toString('utf-8');
      return this.cachedText;
    });

    return this.textPromise;
  }

  /**
   * Parse body as URL-encoded form data
   *
   * Uses the same parser as query parameters for consistent behavior.
   * Caches the parsed result for subsequent calls.
   *
   * @returns Promise that resolves with the parsed form data
   */
  async urlencoded(): Promise<Record<string, unknown>> {
    // Return cached result if available
    if (this.cachedUrlencoded) {
      return this.cachedUrlencoded;
    }

    // Return existing promise if urlencoded() was already called
    if (this.urlencodedPromise) {
      return this.urlencodedPromise;
    }

    // Create and cache the promise
    this.urlencodedPromise = this.text().then((text) => {
      // Use the same parser as query parameters for consistency
      this.cachedUrlencoded = this.parseQuery(text) as Record<string, unknown>;
      return this.cachedUrlencoded;
    });

    return this.urlencodedPromise;
  }

  /**
   * Get body based on content-type (convenience method)
   *
   * **IMPORTANT**: Unlike Express, this returns a Promise because uWebSockets.js
   * body parsing is inherently async. In NestJS, use the @Body() decorator instead
   * of accessing this property directly.
   *
   * Automatically parses the body based on the Content-Type header:
   * - application/json → json()
   * - application/x-www-form-urlencoded → urlencoded()
   * - text/* → text()
   * - default → buffer()
   *
   * @example
   * ```typescript
   * // Must await the promise
   * const data = await request.body;
   *
   * // In NestJS, use decorators instead:
   * @Post()
   * create(@Body() data: CreateDto) {
   *   // data is already parsed
   * }
   * ```
   *
   * @returns Promise that resolves with the parsed body
   */
  get body(): Promise<unknown> {
    // Use is() method for robust content-type matching
    // This handles edge cases like application/vnd.api+json and charset parameters
    if (this.is('json')) {
      return this.json();
    } else if (this.is('application/x-www-form-urlencoded')) {
      return this.urlencoded();
    } else if (this.is('text')) {
      return this.text();
    } else {
      return this.buffer();
    }
  }
}
