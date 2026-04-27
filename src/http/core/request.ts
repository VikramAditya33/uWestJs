import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { Readable } from 'stream';
import * as cookie from 'cookie';
import * as signature from 'cookie-signature';
import type * as busboy from 'busboy';
import type { MultipartFieldHandler } from '../body/multipart-handler';
import { MultipartFormHandler } from '../body/multipart-handler';

/**
 * Buffer watermark for backpressure management
 *
 * When buffered data in 'awaiting' mode exceeds this threshold, the parser pauses
 * to prevent excessive memory usage. The parser resumes when the consumer starts
 * processing the buffered data (switches to buffering or streaming mode).
 */
const BUFFER_WATERMARK = 128 * 1024; // 128KB

/**
 * This is a single shared constant which will be used inside the request class
 * The object is created and frozen exactly once when the file is first loaded. Subsequent requests just point to this same memory address.
 * Since no new objects are being created in that branch, the Garbage Collector has nothing to clean up, which improves the overall latency of the server.
 */
const EMPTY_FROZEN_OBJECT = Object.freeze({});

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
 * HTTP Request wrapper for uWebSockets.js that extends Node.js Readable stream
 *
 * CRITICAL: uWS.HttpRequest is stack-allocated and MUST be cached immediately in constructor.
 * All data from uwsReq must be extracted synchronously before the constructor returns.
 * After the constructor completes, the uwsReq object is deallocated by uWS and cannot be accessed.
 *
 * **Performance Optimizations:**
 * - Lazy evaluation for headers and query parameters - only parsed when first accessed
 * - Parsed results are cached for subsequent access
 * - Minimal memory allocation during construction
 *
 * **Body Parsing:**
 * Unlike Express where req.body is synchronous (populated by middleware), body parsing methods
 * (buffer(), json(), text(), urlencoded()) return Promises because uWebSockets.js streams body
 * data asynchronously. The body getter also returns a Promise.
 *
 * In NestJS applications, use parameter decorators (@Body(), @Req()) instead of direct access.
 *
 * **Readable Stream Support:**
 * This class extends Node.js Readable stream to enable:
 * - Streaming large request bodies without buffering entire content in memory
 * - Piping to other streams (e.g., busboy for multipart/form-data file uploads)
 * - Proper backpressure handling to prevent memory exhaustion
 * - Zero-copy streaming when possible
 *
 * **Hybrid Streaming Modes:**
 * The implementation uses three internal modes for optimal performance:
 *
 * 1. **'awaiting' mode (default):**
 *    - Buffers incoming chunks until the application decides how to consume the body
 *    - Automatically switches to appropriate mode based on first consumption method
 *    - Minimal overhead for requests that don't access the body
 *
 * 2. **'buffering' mode:**
 *    - Used when calling json(), text(), buffer(), or urlencoded()
 *    - Efficiently collects all chunks into memory for parsing
 *    - Results are cached to avoid re-parsing
 *
 * 3. **'streaming' mode:**
 *    - Activated when pipe() is called or stream methods are used
 *    - Pushes chunks directly to the stream consumer
 *    - Implements backpressure by pausing uWS when consumer is slow
 *    - Ideal for large file uploads or streaming processing
 *
 * **Backpressure Handling:**
 * When in streaming mode, the implementation monitors the stream's internal buffer.
 * If push() returns false (buffer full), it pauses the uWS response to prevent
 * overwhelming the consumer. When _read() is called (consumer ready), it resumes uWS.
 *
 * **Example Usage:**
 * ```typescript
 * // Buffered parsing (small bodies)
 * const data = await req.json();
 *
 * // Streaming (large files)
 * req.pipe(fs.createWriteStream('upload.bin'));
 *
 * // Multipart file upload
 * await req.multipart(async (field) => {
 *   if (field.file) {
 *     field.file.stream.pipe(fs.createWriteStream(field.file.filename));
 *   }
 * });
 * ```
 */
export class UwsRequest extends Readable {
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

  // Reference to response (for body parsing and streaming)
  private readonly uwsRes: HttpResponse;

  // Readable stream state (Hybrid streaming implementation)
  private streamActivated = false;
  private bodyParserMode: 'awaiting' | 'buffering' | 'streaming' = 'awaiting';
  private bufferedChunks: Buffer[] = [];
  private totalReceivedBytes = 0;
  private doneReadingData = true; // Default to true, set to false when onData is registered
  private streamPaused = false;
  private maxBodySize = 0; // Maximum allowed body size in bytes
  private aborted = false; // Connection aborted flag
  private abortError?: Error; // Error to reject promises with on abort
  private flushing = false; // Stop processing chunks when true

  // Body parsing (cached results)
  private cachedBody?: Buffer;
  private cachedJson?: unknown;
  private cachedText?: string;
  private cachedUrlencoded?: Record<string, unknown>;

  // Transformed body from pipes (for NestJS middleware pipeline)
  private hasTransformedBody = false;
  private transformedBody?: unknown;

  // Promise caching for body parsing
  private bufferPromise?: Promise<Buffer>;
  private jsonPromise?: Promise<unknown>;
  private textPromise?: Promise<string>;
  private urlencodedPromise?: Promise<Record<string, unknown>>;
  /**
   * Creates a new UwsRequest instance
   *
   * @param uwsReq - Stack-allocated uWS.HttpRequest (MUST cache immediately)
   * @param uwsRes - uWS.HttpResponse (for body parsing and streaming)
   * @param paramNames - Optional array of parameter names for route params
   */
  constructor(uwsReq: HttpRequest, uwsRes: HttpResponse, paramNames?: string[] | undefined) {
    // Initialize Readable stream with highWaterMark matching BUFFER_WATERMARK
    // This ensures consistent backpressure behavior across awaiting and streaming modes
    super({ highWaterMark: BUFFER_WATERMARK });

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

    // Store response reference for body parsing and streaming
    this.uwsRes = uwsRes;

    // Don't register onData here - it will be registered lazily when needed
    // This maintains backward compatibility with existing code
  }

  // ============================================================================
  // Readable Stream Implementation
  // ============================================================================

  /**
   * Handles incoming chunks from uWS with mode-based routing
   *
   * This is the core of the hybrid streaming approach. Depending on the mode:
   * - 'awaiting': Buffers chunks until user decides what to do (json(), text(), pipe(), etc.)
   * - 'buffering': Internal buffering for json(), text(), buffer() methods
   * - 'streaming': Pushes to readable stream for pipe() or stream consumers
   *
   * Also enforces size limits, handles backpressure, and checks for aborted connections.
   *
   * @param chunk - Incoming data chunk
   * @param isLast - Whether this is the last chunk
   * @param fastAbort - Whether to close connection immediately on size limit (no HTTP status)
   * @private
   */
  private handleIncomingChunk(chunk: ArrayBuffer, isLast: boolean, fastAbort = false): void {
    // Skip processing if connection was aborted
    // This prevents race conditions where chunks arrive after abort
    if (this.aborted) {
      return;
    }

    // Ignore empty chunks unless it's the last one
    if (!chunk.byteLength && !isLast) return;

    // Copy the ArrayBuffer immediately to prevent data corruption
    // uWS ArrayBuffers are stack-allocated and get neutered after the callback returns
    // Buffer.from(chunk) creates a view that shares memory, which becomes invalid
    // We must create an independent copy using new Uint8Array(chunk)
    const buffer = Buffer.from(new Uint8Array(chunk));
    this.totalReceivedBytes += buffer.length;

    // Enforce size limit
    if (this.maxBodySize > 0 && this.totalReceivedBytes > this.maxBodySize) {
      // Size limit exceeded - mark as flushing and close connection
      this.flushing = true;
      this.abortError = new Error('Body size limit exceeded');
      this.uwsRes.close();

      // Only emit error if not using fast abort (for proper error handling)
      if (!fastAbort) {
        // Only emit error if there are listeners to handle it
        // This prevents uncaught errors when the stream is not being monitored
        if (this.listenerCount('error') > 0) {
          this.destroy(this.abortError);
        } else {
          this.destroy();
        }
      }
      return;
    }

    // Only process if not flushing
    if (!this.flushing) {
      switch (this.bodyParserMode) {
        case 'awaiting':
          // Buffer chunks until user decides what to do
          this.bufferedChunks.push(buffer);

          // Pause if we've buffered too much (prevent excessive memory usage)
          if (this.totalReceivedBytes > BUFFER_WATERMARK) {
            this.pauseStream();
          }
          break;

        case 'buffering':
          // Internal buffering for json(), text(), buffer() methods
          this.bufferedChunks.push(buffer);
          break;

        case 'streaming':
          // Push to readable stream for pipe() or stream consumers
          if (isLast) {
            this.push(buffer);
            this.push(null); // Signal end of stream
          } else if (!this.push(buffer)) {
            // Backpressure detected - pause uWS
            this.pauseStream();
          }
          break;
      }
    }

    if (isLast) {
      this.doneReadingData = true;
      this.emit('received', this.totalReceivedBytes);
    }
  }

  /**
   * Flush buffered chunks to the stream, respecting backpressure
   * @returns true if all chunks were flushed
   * @private
   */
  private flushBufferedChunks(): boolean {
    let i = 0;
    for (; i < this.bufferedChunks.length; i++) {
      if (!this.push(this.bufferedChunks[i])) {
        // Backpressure detected - stop pushing
        // Remaining chunks will be pushed when _read() is called
        i++; // Include current chunk in removal count
        break;
      }
    }

    // Remove pushed chunks from buffer
    if (i > 0) {
      this.bufferedChunks.splice(0, i);
    }

    return this.bufferedChunks.length === 0;
  }

  /**
   * Activates streaming mode when pipe() or stream methods are called
   * Flushes buffered chunks to the stream
   *
   * @private
   */
  private activateStreaming(): void {
    if (this.streamActivated) return;

    this.streamActivated = true;
    this.bodyParserMode = 'streaming';

    const allFlushed = this.flushBufferedChunks();

    // Only signal EOF if all chunks were pushed and we're done
    if (this.doneReadingData && allFlushed) {
      this.push(null); // Signal end of stream
    }

    // Only resume if we successfully pushed all buffered chunks
    if (allFlushed) {
      this.resumeStream();
    }
  }

  /**
   * Required by Readable stream interface
   * Called by stream consumers when they want more data
   * Handles backpressure automatically
   */
  _read(): void {
    // If still in awaiting mode when _read is called, activate streaming
    // This handles non-pipe consumers (e.g., for await...of, .read(), etc.)
    if (!this.streamActivated && this.bodyParserMode === 'awaiting') {
      this.activateStreaming();
      return;
    }

    // If we have buffered chunks from activateStreaming backpressure, push them now
    if (this.bufferedChunks.length > 0) {
      const allFlushed = this.flushBufferedChunks();

      // Signal EOF if all chunks pushed and done reading
      if (this.doneReadingData && allFlushed) {
        this.push(null);
      }

      // Resume if buffer is empty
      if (allFlushed) {
        this.resumeStream();
      }

      return;
    }

    // Resume uWS if paused due to backpressure in streaming mode
    if (this.bodyParserMode === 'streaming') {
      this.resumeStream();
    }
  }

  /**
   * Override pipe to activate streaming mode
   * This enables zero-copy streaming to busboy, file system, etc.
   */
  // eslint-disable-next-line no-undef
  pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    this.activateStreaming();
    return super.pipe(destination, options);
  }

  /**
   * Pause uWS data flow (backpressure handling)
   */
  private pauseStream(): void {
    if (!this.streamPaused) {
      this.streamPaused = true;
      this.uwsRes.pause();
    }
  }

  /**
   * Resume uWS data flow
   */
  private resumeStream(): void {
    if (this.streamPaused) {
      this.streamPaused = false;
      this.uwsRes.resume();
    }
  }

  /**
   * Pause the request (public API for backpressure)
   * Used by multipart handler to pause data flow when handlers are async
   * Overrides Readable.pause() to also pause uWS data flow
   */
  pause(): this {
    this.pauseStream();
    super.pause();
    return this;
  }

  /**
   * Resume the request (public API for backpressure)
   * Used by multipart handler to resume data flow after async handlers complete
   * Overrides Readable.resume() to also resume uWS data flow
   */
  resume(): this {
    this.resumeStream();
    super.resume();
    return this;
  }

  /**
   * Get total bytes received so far
   */
  getTotalReceivedBytes(): number {
    return this.totalReceivedBytes;
  }

  /**
   * Check if the connection has been aborted
   */
  get isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Check if body has been fully received
   */
  get isReceived(): boolean {
    return this.doneReadingData;
  }

  // ============================================================================
  // Headers and Properties (Existing Implementation)
  // ============================================================================

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
   * Sets up the streaming infrastructure to handle incoming body data with:
   * - Size limit enforcement
   * - Backpressure management
   * - Mode-based chunk routing
   * - Abort handling
   *
   * @param maxBodySize - Maximum body size in bytes
   * @param fastAbort - Whether to close connection immediately on size limit (no HTTP status)
   * @internal
   */
  _initBodyParser(
    maxBodySize: number,
    fastAbort = false,
    response?: import('./response').UwsResponse
  ): void {
    // Store size limit for enforcement
    this.maxBodySize = maxBodySize;

    // Check if we expect a body based on content-length or transfer-encoding
    const contentLength = this.contentLength;

    // Check for chunked transfer encoding
    const transferEncodingHeader = this.get('transfer-encoding');
    const transferEncoding = Array.isArray(transferEncodingHeader)
      ? transferEncodingHeader.join(',')
      : (transferEncodingHeader ?? '');
    const hasChunkedBody = transferEncoding.toLowerCase().includes('chunked');

    // Only skip body handling if:
    // - contentLength is explicitly 0, OR
    // - contentLength is undefined AND no chunked transfer encoding
    if (contentLength === 0 || (contentLength === undefined && !hasChunkedBody)) {
      // No body expected - keep doneReadingData as true
      return;
    }

    // Check size limit before starting to receive data (only for known content-length)
    if (maxBodySize > 0 && contentLength !== undefined && contentLength > maxBodySize) {
      // Body exceeds limit - set error state and close connection
      // Don't call destroy() here to avoid emitting error during construction
      // Body methods will check aborted state via checkAborted() and throw
      this.abortError = new Error('Body size limit exceeded');
      this.aborted = true;
      this.doneReadingData = true; // Mark as done to prevent waiting
      this.uwsRes.close();
      return;
    }

    // We expect a body - set doneReadingData to false
    this.doneReadingData = false;

    // Register abort handler through response multiplexing if available
    if (response) {
      response._onAbort(() => {
        this.aborted = true;
        this.abortError = new Error('Connection aborted');
        this.flushing = true; // Stop processing chunks

        // Only emit error if there are listeners to handle it
        if (this.listenerCount('error') > 0) {
          this.destroy(this.abortError);
        } else {
          this.destroy();
        }
      });
    } else {
      // Fallback: register directly on uwsRes (legacy behavior)
      // This will overwrite any existing handler - not recommended
      this.uwsRes.onAborted(() => {
        this.aborted = true;
        this.abortError = new Error('Connection aborted');
        this.flushing = true;

        if (this.listenerCount('error') > 0) {
          this.destroy(this.abortError);
        } else {
          this.destroy();
        }
      });
    }

    // Register onData callback for streaming infrastructure
    this.uwsRes.onData((chunk, isLast) => {
      this.handleIncomingChunk(chunk, isLast, fastAbort);
    });
  }

  /**
   * Set transformed body from pipes (called by route registry after pipe execution)
   *
   * This allows the middleware pipeline to store the transformed body
   * so it can be accessed by the handler via the body getter.
   *
   * @param body - Transformed body from pipes
   * @internal
   */
  _setTransformedBody(body: unknown): void {
    this.hasTransformedBody = true;
    this.transformedBody = body;
  }

  /**
   * Get raw body as Buffer
   *
   * This method buffers the entire request body into memory.
   * For large bodies, consider using streaming instead (pipe to destination).
   *
   * Uses buffering mode for efficient memory management.
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

    // Switch to buffering mode and resume if paused due to watermark
    const wasAwaiting = this.bodyParserMode === 'awaiting';
    this.bodyParserMode = 'buffering';

    if (wasAwaiting) {
      this.resumeStream();
    }

    // Create and cache the promise
    this.bufferPromise = this.getAllData().then((buffer) => {
      this.cachedBody = buffer;
      return buffer;
    });

    return this.bufferPromise;
  }

  /**
   * Check if connection was aborted and throw error if so
   * @private
   */
  private checkAborted(): void {
    if (this.aborted) {
      throw this.abortError || new Error('Connection aborted');
    }
  }

  /**
   * Get buffered data as a single Buffer
   * @private
   */
  private getBufferedData(): Buffer {
    return this.bufferedChunks.length > 0 ? Buffer.concat(this.bufferedChunks) : Buffer.alloc(0);
  }

  /**
   * Get all buffered data as a single Buffer
   * Waits for all chunks if not yet received
   *
   * Handles abort scenarios.
   *
   * @private
   */
  private async getAllData(): Promise<Buffer> {
    // Check if connection was aborted
    this.checkAborted();

    // If already done reading, return buffered data
    if (this.doneReadingData) {
      return this.getBufferedData();
    }

    // Wait for 'received' event or stream close
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.removeListener('error', onError);
        this.removeListener('received', onReceived);
        this.removeListener('close', onClose);
      };

      // Handle abort or other errors during wait
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onReceived = () => {
        cleanup();
        resolve(this.getBufferedData());
      };

      // Handle stream close (e.g., from destroy())
      const onClose = () => {
        cleanup();
        if (!this.doneReadingData) {
          reject(new Error('Stream closed before data was received'));
        } else {
          resolve(this.getBufferedData());
        }
      };

      this.once('error', onError);
      this.once('received', onReceived);
      this.once('close', onClose);

      // Re-check after registering listeners to handle race condition
      // where 'received' was emitted between the initial check and listener registration
      if (this.doneReadingData) {
        cleanup();
        resolve(this.getBufferedData());
      }
    });
  }

  /**
   * Parse body as JSON
   *
   * Uses buffering mode for efficiency.
   * Caches the parsed result for subsequent calls.
   *
   * For requests with empty bodies:
   * - GET/HEAD/DELETE: Returns a frozen empty object `Object.freeze({})`
   * - Other methods: Throws an error
   *
   * Note: The frozen empty object prevents accidental mutations and will throw
   * a TypeError in strict mode if mutation is attempted.
   *
   * @returns Promise that resolves with the parsed JSON object
   * @throws Error if body is not valid JSON or if body is empty for non-GET/HEAD/DELETE methods
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

    // Create and cache the promise (buffer() handles mode switching)
    this.jsonPromise = this.buffer().then((buffer) => {
      const text = buffer.toString('utf-8').trim();

      // Handle empty body - return frozen empty object for GET/HEAD/DELETE, throw for all other methods
      if (text === '') {
        if (this.method === 'GET' || this.method === 'HEAD' || this.method === 'DELETE') {
          // Use the shared constant to freeze the empty object instead of creating a new one
          // This will throw TypeError in strict mode if mutation is attempted
          this.cachedJson = EMPTY_FROZEN_OBJECT as T;
          return this.cachedJson as T;
        }
        // Throw for POST/PUT/PATCH and other methods (OPTIONS, SEARCH, PROPFIND, etc.)
        throw new Error('Invalid JSON: Request body is empty', {
          cause: new SyntaxError('Unexpected end of JSON input'),
        });
      }

      try {
        this.cachedJson = JSON.parse(text);
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
   * Uses buffering mode for efficiency.
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

    // Create and cache the promise (buffer() handles mode switching)
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
   * Uses buffering mode for efficiency.
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

    // Create and cache the promise (text() -> buffer() handles mode switching)
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
    // If body was transformed by pipes, return that instead of re-parsing
    if (this.hasTransformedBody) {
      return Promise.resolve(this.transformedBody);
    }

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

  /**
   * Parse multipart/form-data request body
   *
   * This method enables streaming processing of multipart form data, including file uploads.
   * It automatically activates streaming mode and pipes the request body to busboy for parsing.
   *
   * The handler function is called for each field/file in the multipart form. For file fields,
   * the handler receives a readable stream that can be piped to a file or processed in chunks.
   *
   * **Backpressure Handling:**
   * - If the handler returns a Promise, the parser pauses until the Promise resolves
   * - This prevents overwhelming the handler with concurrent fields
   * - File streams that aren't consumed are automatically flushed
   *
   * **Limits:**
   * - Configure busboy limits via options parameter
   * - When limits are exceeded, the Promise rejects with a limit code
   *
   * @param options - Busboy configuration options or handler function
   * @param handler - Function to handle each field/file (required if options is provided)
   * @returns Promise that resolves when all fields are processed
   * @throws {MultipartLimitReject} When busboy limits are exceeded
   * @throws {Error} When parsing fails
   *
   * @example
   * ```typescript
   * // Basic usage
   * await req.multipart(async (field) => {
   *   if (field.file) {
   *     // Handle file upload
   *     await saveFile(field.file.stream, field.file.filename);
   *   } else {
   *     // Handle regular field
   *     console.log(field.name, field.value);
   *   }
   * });
   *
   * // With options
   * await req.multipart({
   *   limits: {
   *     fileSize: 10 * 1024 * 1024, // 10MB
   *     files: 5,
   *   }
   * }, async (field) => {
   *   // Handle field
   * });
   * ```
   */
  async multipart(
    options: busboy.BusboyConfig | MultipartFieldHandler,
    handler?: MultipartFieldHandler
  ): Promise<void> {
    // Migrate options to handler if no options object is provided
    if (typeof options === 'function') {
      handler = options as MultipartFieldHandler;
      options = {};
    }

    // Ensure handler is provided
    if (typeof handler !== 'function') {
      throw new Error('multipart() requires a handler function');
    }

    // Throw error if request body has already been consumed
    // Check if body was already parsed or if we're in buffering/streaming mode
    if (this.cachedBody !== undefined || this.bodyParserMode !== 'awaiting') {
      throw new Error('Cannot parse multipart: request body already consumed');
    }

    // Throw error if content-type is not multipart
    const contentType = this.contentType;
    if (!contentType || !contentType.toLowerCase().startsWith('multipart/')) {
      throw new Error(
        `Cannot parse multipart: Content-Type must be multipart/*, got: ${contentType || 'none'}`
      );
    }

    // Create multipart handler and parse
    const multipartHandler = new MultipartFormHandler(this, {
      ...options,
      headers: this.headers, // Always use actual request headers (override any passed in options)
    });

    return multipartHandler.parse(handler);
  }
}
