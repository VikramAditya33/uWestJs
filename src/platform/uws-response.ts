import type { HttpResponse } from 'uWebSockets.js';
import { STATUS_CODES } from 'http';
import { Writable } from 'stream';
import * as cookie from 'cookie';
import * as signature from 'cookie-signature';
import * as mime from 'mime-types';
import contentDisposition = require('content-disposition');

/**
 * High watermark for response buffering (128KB)
 * Used for both internal chunk batching and Writable stream configuration
 */
export const HIGH_WATERMARK = 128 * 1024;

/**
 * Cookie options for setting cookies
 */
export interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: boolean | 'none' | 'lax' | 'strict';
  signed?: boolean;
  secret?: string;
  encode?: (str: string) => string;
}

/**
 * HTTP Response wrapper for uWebSockets.js
 *
 * Extends Node.js Writable stream for platform agnosticism and ecosystem compatibility.
 * Provides three API tiers:
 * 1. Standard Writable Stream API (platform-agnostic, works with Node.js ecosystem)
 * 2. Optimized stream() method (platform-specific, high performance with uWS features)
 * 3. Express-compatible pipe() (convenience wrapper for familiar API)
 *
 * CRITICAL: All writes to uWS.HttpResponse must be corked for performance.
 * Cork batches multiple operations into a single syscall, which is required by uWS.
 *
 * This implementation provides a chainable API for setting status, headers, and cookies
 * before sending the response. The cork() method ensures all operations are batched.
 *
 * Chunk Batching Strategy:
 * - Accumulates small chunks to reduce syscalls and improve throughput
 * - Flushes when HIGH_WATERMARK (128KB) is reached to prevent excessive memory usage
 * - Flushes after FLUSH_INTERVAL (50ms) timeout to maintain low latency
 * - First chunk is sent immediately to minimize time-to-first-byte
 *
 * This approach optimizes for both throughput (fewer syscalls) and latency (timely delivery)
 * making it suitable for streaming responses, SSE, file downloads, and chunked transfers.
 */
export class UwsResponse extends Writable {
  private headers: Record<string, string | string[]> = {};
  private cookies: Record<string, string> = {};
  private statusCode = 200;
  private statusMessage?: string;
  private _headersSent = false;
  private finished = false;
  private aborted = false;

  // Chunk batching properties
  private pendingChunks: Buffer[] = [];
  private pendingSize = 0;
  private lastFlushTime = 0;
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global type from @types/node
  private flushTimeout?: NodeJS.Timeout;
  private readonly FLUSH_INTERVAL = 50; // 50ms

  // Active readable stream being processed by stream()
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global namespace from @types/node
  private activeStream?: NodeJS.ReadableStream;

  // Pending _final callback from Writable stream
  // Stored when _final() is called and invoked when response truly finishes
  private pendingFinalCallback?: (error?: Error | null) => void;

  constructor(private readonly uwsRes: HttpResponse) {
    // Initialize Writable stream with platform-agnostic interface
    super({
      highWaterMark: HIGH_WATERMARK,
      // Note: We don't pass write/writev here because we override _write/_writev methods
    });

    // Bind abort handler to track connection state
    // This is required by uWS for async processing
    uwsRes.onAborted(() => {
      this.aborted = true;
      this.finished = true;
      // Clear any pending flush timeout
      if (this.flushTimeout) {
        clearTimeout(this.flushTimeout);
        this.flushTimeout = undefined;
      }
      // Destroy active stream if streaming
      if (
        this.activeStream &&
        'destroy' in this.activeStream &&
        typeof this.activeStream.destroy === 'function'
      ) {
        this.activeStream.destroy();
      }

      // Invoke pending _final callback if present (connection aborted before completion)
      if (this.pendingFinalCallback) {
        const callback = this.pendingFinalCallback;
        this.pendingFinalCallback = undefined;
        // Call with error to indicate abnormal termination
        callback(new Error('Connection aborted'));
      }

      // Emit 'close' event for Writable stream compatibility
      this.emit('close');
    });
  }

  /**
   * Check if headers have been sent
   *
   * @returns true if headers have been sent to the client
   */
  get headersSent(): boolean {
    return this._headersSent;
  }

  /**
   * Platform-agnostic Writable stream interface
   *
   * Implements the standard Node.js Writable._write() method for ecosystem compatibility.
   * This allows UwsResponse to work with any Node.js stream utility.
   *
   * For platform agnosticism:
   * - Express platform: delegate to res.write()
   * - Fastify platform: delegate to reply.send()
   * - uWS platform: use streamChunk() with backpressure handling
   *
   * @param chunk - Data to write
   * @param encoding - Character encoding
   * @param callback - Callback to invoke when write completes
   */

  /**
   * Ensure headers are sent before writing body
   *
   * This is called by all write paths to guarantee headers are sent
   * before the first body chunk. Subsequent calls are no-ops.
   */
  private ensureHeadersSent(): void {
    if (!this._headersSent) {
      this.writeHead();
    }
  }

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding, // eslint-disable-line no-undef -- BufferEncoding is a TypeScript global type from @types/node
    callback: (error?: Error | null) => void
  ): void {
    // Convert to Buffer if needed
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

    // Delegate to platform-specific streaming with backpressure handling
    this.streamChunk(buffer)
      .then(() => callback())
      .catch((error) => callback(error));
  }

  /**
   * Platform-agnostic Writable stream interface for batch writes
   *
   * Implements the standard Node.js Writable._writev() method for optimized batch writes.
   * Combines multiple chunks into a single write operation for better performance.
   *
   * @param chunks - Array of chunks to write
   * @param callback - Callback to invoke when write completes
   */

  _writev(
    chunks: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>, // eslint-disable-line no-undef -- BufferEncoding is a TypeScript global type from @types/node
    callback: (error?: Error | null) => void
  ): void {
    // Combine all chunks into a single buffer
    const buffers = chunks.map((c) =>
      Buffer.isBuffer(c.chunk) ? c.chunk : Buffer.from(c.chunk, c.encoding)
    );
    const combined = Buffer.concat(buffers);

    // Write combined buffer (use 'utf8' as a valid BufferEncoding)
    this._write(combined, 'utf8', callback);
  }

  /**
   * Implement Writable._final() for proper stream finalization
   *
   * This is called by the Writable stream after all data has been written
   * and the internal buffer has been drained. This ensures that pending
   * chunks from _write() are fully flushed before finalizing the response.
   *
   * **Important**: The callback must only be invoked after the response is truly finished,
   * including waiting for backpressure to clear. We store the callback and invoke it
   * when `send()` completes (either immediately or after `onWritable` drains).
   *
   * @param callback - Callback to invoke after finalization completes
   */
  _final(callback: (error?: Error | null) => void): void {
    try {
      // Store the callback to be invoked when response truly finishes
      this.pendingFinalCallback = callback;

      // Finalize response if not already done
      if (!this.finished && !this.aborted) {
        this.send();
      } else {
        // Already finished/aborted, invoke callback immediately
        const cb = this.pendingFinalCallback;
        this.pendingFinalCallback = undefined;
        cb();
      }
    } catch (error) {
      // Clear stored callback and invoke with error
      const cb = this.pendingFinalCallback;
      this.pendingFinalCallback = undefined;
      if (cb) {
        cb(error as Error);
      }
    }
  }

  /**
   * Set HTTP status code
   *
   * @param code - HTTP status code (e.g., 200, 404, 500)
   * @param message - Optional custom status message
   * @returns this for chaining
   */
  status(code: number, message?: string): this {
    if (this._headersSent) {
      throw new Error('Cannot set status after headers are sent');
    }
    this.statusCode = code;
    this.statusMessage = message;
    return this;
  }

  /**
   * Set response header
   *
   * By default, this overwrites existing headers (Express-compatible behavior).
   * Set overwrite=false to append instead.
   *
   * Supports multiple values for the same header name.
   *
   * @param name - Header name (case-insensitive)
   * @param value - Header value (string or array of strings)
   * @param overwrite - Whether to overwrite existing header (default: true for Express compatibility)
   * @returns this for chaining
   */
  setHeader(name: string, value: string | string[], overwrite = true): this {
    if (this._headersSent) {
      throw new Error('Cannot set headers after they are sent');
    }

    const lowerName = name.toLowerCase();

    if (overwrite) {
      this.headers[lowerName] = value;
    } else if (this.headers[lowerName] !== undefined) {
      // Header already exists - accumulate values
      const existing = this.headers[lowerName];
      const existingArr = Array.isArray(existing) ? existing : [existing];
      const newValues = Array.isArray(value) ? value : [value];
      this.headers[lowerName] = [...existingArr, ...newValues];
    } else {
      this.headers[lowerName] = value;
    }

    return this;
  }

  /**
   * Alias for setHeader (Express compatibility)
   *
   * Overwrites existing headers by default (Express behavior).
   */
  header(name: string, value: string | string[]): this {
    return this.setHeader(name, value, true);
  }

  /**
   * Append value to response header (Express compatibility)
   *
   * If the header already exists, appends the new value.
   * If the header doesn't exist, creates it.
   *
   * @param name - Header name (case-insensitive)
   * @param value - Header value to append
   * @returns this for chaining
   */
  append(name: string, value: string | string[]): this {
    return this.setHeader(name, value, false);
  }

  /**
   * Get response header value
   *
   * @param name - Header name (case-insensitive)
   * @returns Header value or undefined
   */
  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   * Remove response header
   *
   * @param name - Header name (case-insensitive)
   * @returns this for chaining
   */
  removeHeader(name: string): this {
    if (this._headersSent) {
      throw new Error('Cannot remove headers after they are sent');
    }
    delete this.headers[name.toLowerCase()];
    return this;
  }

  /**
   * Check if header exists
   *
   * @param name - Header name (case-insensitive)
   * @returns true if header is set
   */
  hasHeader(name: string): boolean {
    return this.headers[name.toLowerCase()] !== undefined;
  }

  /**
   * Set content type header with MIME type lookup
   *
   * Accepts file extensions (with or without leading dot) or full MIME types.
   * Automatically looks up MIME types for common extensions.
   *
   * Falls back to 'application/octet-stream' if the type cannot be resolved
   * to a valid MIME type (must contain '/').
   *
   * @param type - Content type or file extension (e.g., 'json', '.html', 'application/json')
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * res.type('json');  // Sets 'application/json; charset=utf-8'
   * res.type('.html'); // Sets 'text/html; charset=utf-8'
   * res.type('png');   // Sets 'image/png'
   * res.type('application/pdf'); // Sets 'application/pdf'
   * res.type('README'); // Sets 'application/octet-stream' (invalid MIME type)
   * ```
   */
  type(type: string): this {
    // Remove leading dot if present
    if (type[0] === '.') {
      type = type.substring(1);
    }

    // Get full content-type (with charset if applicable)
    const contentType =
      mime.contentType(type) || (type.includes('/') ? type : 'application/octet-stream');
    return this.setHeader('content-type', contentType, true);
  }

  /**
   * Alias for type() - Express compatibility
   *
   * @param type - Content type or file extension
   * @returns this for chaining
   */
  contentType(type: string): this {
    return this.type(type);
  }

  /**
   * Set cookie (low-level API)
   *
   * Basic cookie setting with signing support. Use this for simple string cookies.
   * For Express compatibility and advanced features (object serialization, maxAge conversion),
   * use the `cookie()` method instead.
   *
   * **Differences from `cookie()`:**
   * - Only accepts string values (no automatic JSON serialization)
   * - maxAge is in seconds (not milliseconds)
   * - No automatic maxAge to expires conversion
   * - Use `secret` option directly (not `signed` + `secret`)
   *
   * @param name - Cookie name
   * @param value - Cookie value (null to delete cookie)
   * @param options - Cookie options
   * @returns this for chaining
   *
   * @see cookie() for Express-compatible API with more features
   */
  setCookie(name: string, value: string | null, options?: CookieOptions): this {
    if (this._headersSent) {
      throw new Error('Cannot set cookies after headers are sent');
    }

    // Apply default options (Express-compatible: only path defaults to '/')
    // Note: secure and sameSite are NOT set by default to allow local development over HTTP
    const defaultOpts: CookieOptions = {
      path: '/',
    };
    const opts: CookieOptions = { ...defaultOpts, ...options };

    // Delete cookie if value is null
    if (value === null) {
      return this.setCookie(name, '', { ...opts, maxAge: 0 });
    }

    // Sign cookie if secret is provided
    let cookieValue = value;
    if (opts.secret && typeof opts.secret === 'string') {
      // Disable encoding to preserve signature
      delete opts.encode;
      // Add 's:' prefix for Express compatibility
      cookieValue = 's:' + signature.sign(value, opts.secret);
      delete opts.secret; // Remove secret before serialization
    }

    // Serialize cookie
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cookies[name] = cookie.serialize(name, cookieValue, opts as any);

    return this;
  }

  /**
   * Set cookie (Express-compatible API - recommended)
   *
   * Full-featured cookie setting with Express compatibility. Supports object serialization,
   * maxAge in milliseconds, and signed cookies. This is the recommended method for most use cases.
   *
   * **Features:**
   * - Automatic JSON serialization for object values (prefixed with `j:`)
   * - maxAge in milliseconds (automatically converted to seconds and expires date)
   * - Signed cookies with `signed: true` option (prefixed with `s:`)
   * - Default path handling
   *
   * **Differences from `setCookie()`:**
   * - Accepts string or object values (automatic JSON serialization)
   * - maxAge is in milliseconds (Express convention)
   * - Automatic maxAge to expires conversion
   * - Use `signed: true` + `secret` for signing (Express convention)
   *
   * **Security Best Practices:**
   * - `httpOnly: true` - Prevents JavaScript access (XSS protection)
   * - `secure: true` - Requires HTTPS (prevents MITM attacks)
   * - `sameSite: 'strict'` or `'lax'` - CSRF protection
   *
   * **Note:** For local development over HTTP, omit `secure` or set to `false`.
   * Use `process.env.NODE_ENV === 'production'` to conditionally enable it.
   *
   * @param name - Cookie name
   * @param value - Cookie value (string or object for JSON serialization)
   * @param options - Cookie options
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * // Development (HTTP)
   * res.cookie('session', 'abc123', {
   *   httpOnly: true,
   *   sameSite: 'lax'
   * });
   *
   * // Production (HTTPS) - environment-aware
   * res.cookie('session', 'abc123', {
   *   httpOnly: true,
   *   secure: process.env.NODE_ENV === 'production',
   *   sameSite: 'strict',
   *   maxAge: 900000 // 15 minutes in milliseconds
   * });
   *
   * // Signed cookie (Express convention)
   * res.cookie('user', 'vikram', {
   *   signed: true,
   *   secret: 'my-secret'
   * });
   *
   * // JSON cookie (automatic serialization)
   * res.cookie('cart', { items: [1, 2, 3] });
   * ```
   *
   * @see setCookie() for low-level API without Express features
   */
  cookie(name: string, value: string | object, options?: CookieOptions): this {
    if (this._headersSent) {
      throw new Error('Cannot set cookies after headers are sent');
    }

    // Create a copy of options to avoid mutation
    const opts: CookieOptions = { ...(options ?? {}) };

    // Serialize object values to JSON
    let val = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

    // Handle maxAge conversion from milliseconds to seconds
    if (opts.maxAge != null) {
      opts.expires = new Date(Date.now() + opts.maxAge);
      opts.maxAge = Math.floor(opts.maxAge / 1000);
    }

    // Sign cookie if signed option is true and secret is provided
    if (opts.signed && opts.secret) {
      val = 's:' + signature.sign(val, opts.secret);
      delete opts.secret; // Remove secret before serialization
    }

    // Set default path if not provided
    if (opts.path == null) {
      opts.path = '/';
    }

    // Serialize and store cookie
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.cookies[name] = cookie.serialize(name, val, opts as any);

    return this;
  }

  /**
   * Clear cookie (Express-compatible)
   *
   * Sets cookie with empty value and expires date in the past.
   *
   * @param name - Cookie name to clear
   * @param options - Cookie options (should match original cookie options for proper clearing)
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * // Clear simple cookie
   * res.clearCookie('session');
   *
   * // Clear cookie with specific path/domain
   * res.clearCookie('session', { path: '/admin', domain: '.example.com' });
   * ```
   */
  clearCookie(name: string, options?: CookieOptions): this {
    const opts = { path: '/', ...options, expires: new Date(1) };
    delete opts.maxAge;
    return this.cookie(name, '', opts);
  }

  /**
   * Cork wrapper for batching uWS operations
   *
   * All writes to uWS.HttpResponse must be corked for performance.
   * This batches multiple operations into a single syscall.
   *
   * **Important:** The callback is always executed, but behavior differs based on state:
   * - If response is active: callback runs within uWS cork context (batched)
   * - If finished/aborted: callback runs immediately without cork (no-op for writes)
   *
   * Callers should check `this.finished` or `this.aborted` inside the callback
   * to avoid attempting writes on closed responses.
   *
   * Note: This is a uWS-specific method that takes a callback, different from
   * Writable.cork() which doesn't. For Writable.cork() compatibility, use the
   * inherited cork() method from the Writable base class.
   *
   * @param callback - Function to execute within cork context (or immediately if finished/aborted)
   */
  atomic(callback: () => void): void {
    if (!this.finished && !this.aborted) {
      this.uwsRes.cork(callback);
    } else {
      // If already finished/aborted, just call the callback
      callback();
    }
  }

  /**
   * Write chunk to response with batching (uWS-specific optimized method)
   *
   * Implements intelligent chunk batching to optimize network performance:
   * - First chunk is sent immediately to minimize initial response latency
   * - Subsequent chunks are accumulated in memory to reduce syscalls
   * - Automatic flush when HIGH_WATERMARK (128KB) is reached to prevent memory buildup
   * - Timeout-based flush after FLUSH_INTERVAL (50ms) to prevent response stalling
   *
   * This batching strategy balances latency, throughput, and memory usage for
   * streaming responses like server-sent events, file downloads, or chunked transfers.
   *
   * For platform-agnostic code, use the inherited write() method from Writable.
   * This method provides uWS-specific optimizations.
   *
   * @param chunk - Data to write (string, Buffer, or ArrayBuffer)
   * @param encoding - Character encoding (default: 'utf8')
   * @returns true if write succeeded, false if backpressure detected or response finished/aborted
   */
  // eslint-disable-next-line no-undef -- BufferEncoding is a TypeScript global type from @types/node
  writeChunk(chunk: string | Buffer | ArrayBuffer, encoding?: BufferEncoding): boolean {
    if (this.finished || this.aborted) {
      return false;
    }

    let writeResult = true;

    this.atomic(() => {
      // Write headers if not already sent
      if (!this._headersSent) {
        this.writeHead();
      }

      // Convert to Buffer
      let buffer: Buffer;
      if (Buffer.isBuffer(chunk)) {
        buffer = chunk;
      } else if (chunk instanceof ArrayBuffer) {
        buffer = Buffer.from(chunk);
      } else {
        buffer = Buffer.from(chunk, encoding || 'utf8');
      }

      // Add to pending chunks
      this.pendingChunks.push(buffer);
      this.pendingSize += buffer.length;

      // Use tracked size instead of recalculating
      const totalSize = this.pendingSize;

      const now = Date.now();
      const elapsed = now - this.lastFlushTime;

      // Flush if:
      // - First chunk (lastFlushTime === 0) - send immediately for low latency
      // - Watermark reached (totalSize >= HIGH_WATERMARK)
      // - Timeout elapsed (elapsed > FLUSH_INTERVAL)
      if (
        this.lastFlushTime === 0 ||
        totalSize >= HIGH_WATERMARK ||
        elapsed > this.FLUSH_INTERVAL
      ) {
        writeResult = this.flushChunks();

        // If backpressure detected, schedule retry via onWritable
        if (!writeResult && !this.finished && !this.aborted) {
          this.uwsRes.onWritable(() => {
            // Check if connection is still active
            if (this.finished || this.aborted) {
              return true; // Remove handler
            }

            // Retry flushing pending chunks
            return this.flushChunks();
          });
        }
      } else if (!this.flushTimeout) {
        // Schedule flush after timeout
        this.flushTimeout = setTimeout(() => {
          this.flushTimeout = undefined;
          if (!this.finished && !this.aborted) {
            this.atomic(() => {
              this.flushChunks();
            });
          }
        }, this.FLUSH_INTERVAL);
        // Don't prevent process exit
        this.flushTimeout.unref();
      }
    });

    return writeResult;
  }

  /**
   * Flush pending chunks to uWS
   *
   * Concatenates all pending chunks into a single buffer and writes to uWS.
   * Clears the pending chunks array and updates the last flush time.
   *
   * @returns true if write succeeded, false if backpressure detected
   */
  private flushChunks(): boolean {
    if (this.pendingChunks.length === 0) {
      return true;
    }

    // Clear timeout if exists
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
    }

    // Concatenate and write
    const buffer = Buffer.concat(this.pendingChunks);
    const writeSucceeded = this.uwsRes.write(buffer);

    // Only clear pending chunks and update time if write succeeded
    if (writeSucceeded) {
      this.pendingChunks = [];
      this.pendingSize = 0;
      this.lastFlushTime = Date.now();
    }

    return writeSucceeded;
  }

  /**
   * Stream a readable stream to the response with backpressure handling
   *
   * Supports two modes:
   * 1. Chunked transfer encoding (no totalSize) - streams without content-length header
   * 2. Content-length mode (with totalSize) - uses tryEnd() for optimal performance
   *
   * Handles backpressure automatically by waiting for drain events when the client
   * is slow to consume data. This prevents memory buildup on the server.
   *
   * Uses manual chunk reading with event-based flow control for reliable streaming.
   *
   * @param readable - Readable stream to consume
   * @param totalSize - Optional total size in bytes (enables content-length mode)
   * @returns Promise that resolves when stream is fully consumed
   *
   * @example
   * ```typescript
   * // Stream file with known size
   * const fileStream = fs.createReadStream('large-file.mp4');
   * const stats = fs.statSync('large-file.mp4');
   * await res.stream(fileStream, stats.size);
   *
   * // Stream with chunked encoding
   * const dataStream = getDataStream();
   * await res.stream(dataStream);
   * ```
   */
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global namespace from @types/node
  async stream(readable: NodeJS.ReadableStream, totalSize?: number): Promise<void> {
    if (this.finished || this.aborted) {
      return;
    }

    // Flush any pending chunks from write() calls
    this.atomic(() => {
      this.flushChunks();

      // Set content-length header if totalSize provided (before headers are sent)
      if (totalSize !== undefined && !this._headersSent) {
        this.setHeader('content-length', totalSize.toString());
      }
      // Note: Headers will be sent by streamChunk() on first write
    });

    // Register this stream so the constructor's abort handler can destroy it
    this.activeStream = readable;

    try {
      // Stream chunks using manual read() with event-based flow control
      // This is more reliable than async iteration for Node.js streams
      while (!this.finished && !this.aborted && !this.isStreamEnded(readable)) {
        // Attempt to read a chunk from the stream
        let chunk = this.readChunk(readable);

        if (!chunk) {
          // Check if stream ended after read() returned null
          // This handles the case where push(null) was called but readableEnded isn't set yet
          if (this.isStreamEnded(readable)) {
            break;
          }

          // Wait for the stream to emit 'readable', 'end', or 'close' event
          await new Promise<void>((resolve, reject) => {
            // Handle end event
            const onEnd = () => {
              cleanup();
              resolve();
            };

            // Handle readable event
            const onReadable = () => {
              cleanup();
              resolve();
            };

            // Handle error event
            const onError = (err: Error) => {
              cleanup();
              reject(err);
            };

            // Handle close event (emitted by destroy())
            const onClose = () => {
              cleanup();
              resolve();
            };

            const cleanup = () => {
              readable.removeListener('end', onEnd);
              readable.removeListener('readable', onReadable);
              readable.removeListener('error', onError);
              readable.removeListener('close', onClose);
            };

            readable.once('end', onEnd);
            readable.once('readable', onReadable);
            readable.once('error', onError);
            readable.once('close', onClose);
          });

          // Check again if stream ended while waiting
          if (this.isStreamEnded(readable)) {
            break;
          }

          // Try reading again after event
          chunk = this.readChunk(readable);
        }

        // Stream the chunk if available
        if (chunk) {
          await this.streamChunk(chunk, totalSize);
        }
      }

      // End response if using chunked encoding (no totalSize)
      if (!this.finished && totalSize === undefined) {
        this.atomic(() => {
          this.uwsRes.end();
          this.finished = true;
        });
      }
    } catch (error) {
      // Stream error - send error response if headers not sent
      if (!this._headersSent && !this.aborted) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.status(500).send({ error: 'Stream error', message: errorMessage });
      }
      throw error;
    } finally {
      // Clear active stream reference
      this.activeStream = undefined;
    }
  }

  /**
   * Check if stream has ended
   */
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global namespace from @types/node
  private isStreamEnded(readable: NodeJS.ReadableStream): boolean {
    return (
      ('readableEnded' in readable && readable.readableEnded === true) ||
      ('destroyed' in readable && readable.destroyed === true)
    );
  }

  /**
   * Read a chunk from the stream
   */
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global namespace from @types/node
  private readChunk(readable: NodeJS.ReadableStream): Buffer | null {
    if ('read' in readable && typeof readable.read === 'function') {
      const chunk = readable.read();
      return chunk ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) : null;
    }
    return null;
  }

  /**
   * Stream a single chunk with backpressure handling
   *
   * Uses different strategies based on whether totalSize is known:
   * - With totalSize: Uses tryEnd() which is more efficient
   * - Without totalSize: Uses write() for chunked encoding
   *
   * Handles backpressure by waiting for onWritable callback when buffer is full.
   *
   * @param chunk - Data chunk to write
   * @param totalSize - Optional total size for tryEnd() mode
   * @returns Promise that resolves when chunk is fully written
   */
  private async streamChunk(chunk: Buffer, totalSize?: number): Promise<void> {
    if (this.aborted || this.finished) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.atomic(() => {
        if (this.aborted || this.finished) {
          return resolve();
        }

        // Ensure headers are sent before first body write
        this.ensureHeadersSent();

        // Convert to Buffer if needed
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        // Remember write offset for backpressure handling
        const writeOffset = this.uwsRes.getWriteOffset();

        // Try to write chunk
        let sent: boolean;

        if (totalSize !== undefined) {
          // Use tryEnd() when total size is known
          const result = this.uwsRes.tryEnd(buffer, totalSize);
          sent = result[0];
          const done = result[1];

          if (done) {
            this.finished = true;
          }
        } else {
          // Use write() for chunked encoding
          sent = this.uwsRes.write(buffer);
        }

        if (sent) {
          // Chunk fully sent
          resolve();
        } else {
          // Backpressure - wait for drain
          this.uwsRes.onWritable((offset) => {
            if (this.aborted || this.finished) {
              resolve();
              return true;
            }

            // Calculate remaining chunk to send
            const remaining = buffer.slice(offset - writeOffset);

            // Retry with remaining chunk
            let flushed: boolean;
            if (totalSize !== undefined) {
              const result = this.uwsRes.tryEnd(remaining, totalSize);
              flushed = result[0];
              if (result[1]) {
                this.finished = true;
              }
            } else {
              flushed = this.uwsRes.write(remaining);
            }

            if (flushed) {
              resolve();
            }

            // Return true if flushed, false to wait for more drain events
            return flushed;
          });
        }
      });
    });
  }

  /**
   * Pipe a readable stream to the response
   *
   * This is a convenience wrapper around stream() that provides Express-compatible
   * pipe() semantics. It properly handles backpressure using uWS's onWritable mechanism.
   *
   * The stream() method handles all error cases internally, including sending
   * appropriate error responses when streaming fails.
   *
   * Named 'pipeFrom' to avoid conflict with Writable.pipe() which has different semantics
   * (Writable.pipe() pipes TO a destination, this pipes FROM a source).
   *
   * **Note**: Since UwsResponse extends Writable, you can also use standard Node.js piping:
   * ```typescript
   * // Standard Node.js (automatic backpressure via Writable interface)
   * readableStream.pipe(response);
   *
   * // Or use this convenience method (same result)
   * response.pipeFrom(readableStream);
   * ```
   *
   * Both approaches handle backpressure correctly. The standard pipe() uses the Writable
   * interface (_write callback), while pipeFrom() uses stream() with uWS onWritable.
   *
   * @param source - Readable stream to pipe
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * const fileStream = fs.createReadStream('file.txt');
   * res.pipeFrom(fileStream);
   * ```
   */
  // eslint-disable-next-line no-undef -- NodeJS is a TypeScript global namespace from @types/node
  pipeFrom(source: NodeJS.ReadableStream): this {
    // Use stream() which has proper backpressure handling and error handling
    // stream() returns a Promise, but pipeFrom() should be synchronous for Express compatibility
    this.stream(source).catch((error) => {
      // stream() already handles errors internally by sending error responses
      // Emit error event for consumers who want to handle it
      this.emit('error', error);
    });

    return this;
  }

  /**
   * Write HTTP status and headers to uWS
   *
   * This is called automatically by send() and end().
   * After this is called, no more headers can be set.
   */
  private writeHead(): void {
    if (this._headersSent) {
      return;
    }

    // Write status line
    const statusText = this.statusMessage || STATUS_CODES[this.statusCode] || '';
    this.uwsRes.writeStatus(`${this.statusCode} ${statusText}`.trim());

    // Write headers
    for (const [name, value] of Object.entries(this.headers)) {
      if (Array.isArray(value)) {
        // Write each value separately for multi-value headers
        for (const v of value) {
          this.uwsRes.writeHeader(name, v);
        }
      } else {
        this.uwsRes.writeHeader(name, value);
      }
    }

    // Write cookies as Set-Cookie headers
    for (const cookieStr of Object.values(this.cookies)) {
      this.uwsRes.writeHeader('set-cookie', cookieStr);
    }

    this._headersSent = true;
  }

  /**
   * Send response body and end the response
   *
   * Automatically handles:
   * - Flushing any pending chunks
   * - Writing status and headers (if not already sent)
   * - Converting plain objects/arrays to JSON
   * - Setting content-type for JSON
   * - Corking all operations
   *
   * @param body - Response body (string, Buffer, object, array, or undefined)
   */
  send(body?: string | Buffer | Record<string, unknown> | unknown[]): void {
    if (this.aborted) {
      return; // Silently ignore if connection aborted
    }

    if (this.finished) {
      throw new Error('Response already sent');
    }

    this.atomic(() => {
      // Flush any pending chunks first and check for backpressure
      const flushed = this.flushChunks();

      let finalBody: string | Buffer | undefined;

      // Handle null/undefined
      if (body === null || body === undefined) {
        finalBody = undefined;
      } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
        // String or Buffer - send as-is
        finalBody = body;
      } else if (typeof body === 'object') {
        // Plain object/array - serialize as JSON
        if (!this._headersSent && !this.hasHeader('content-type')) {
          this.setHeader('content-type', 'application/json; charset=utf-8');
        }
        finalBody = JSON.stringify(body);
      } else {
        // Other types (shouldn't happen with our type signature, but be safe)
        finalBody = String(body);
      }

      // Write headers if not already sent
      if (!this._headersSent) {
        this.writeHead();
      }

      // If flush failed due to backpressure, wait for socket to become writable
      if (!flushed) {
        // Set up onWritable handler to retry flushing and then end
        this.uwsRes.onWritable((_offset: number) => {
          // Check if connection was aborted while waiting
          if (this.aborted) {
            return true; // Remove handler, connection is gone
          }

          // Try to flush pending chunks again
          const retryFlushed = this.flushChunks();

          if (retryFlushed) {
            // Successfully flushed, now send the final body
            if (finalBody !== undefined) {
              this.uwsRes.end(finalBody);
            } else {
              this.uwsRes.end();
            }

            this.finished = true;

            // Invoke pending _final callback if present
            if (this.pendingFinalCallback) {
              const callback = this.pendingFinalCallback;
              this.pendingFinalCallback = undefined;
              callback();
            }

            this.emit('finish');

            return true; // Done, remove handler
          }

          // Still backpressure, keep handler registered
          return false;
        });
      } else {
        // No backpressure, send immediately
        if (finalBody !== undefined) {
          this.uwsRes.end(finalBody);
        } else {
          this.uwsRes.end();
        }

        this.finished = true;

        // Invoke pending _final callback if present
        if (this.pendingFinalCallback) {
          const callback = this.pendingFinalCallback;
          this.pendingFinalCallback = undefined;
          callback();
        }

        this.emit('finish');
      }
    });
  }

  /**
   * Send JSON response
   *
   * Convenience method that sets content-type and stringifies the object.
   *
   * @param data - Object to send as JSON
   *
   * @example
   * ```typescript
   * res.json({ message: 'Hello', count: 42 });
   * ```
   */
  json(data: unknown): void {
    if (!this.hasHeader('content-type')) {
      this.type('json');
    }
    this.send(JSON.stringify(data));
  }

  /**
   * Set Content-Disposition header for file downloads
   *
   * Sets the Content-Disposition header to "attachment" and optionally
   * sets the filename and content-type based on the file extension.
   *
   * @param filename - Optional filename for the download
   * @returns this for chaining
   *
   * @example
   * ```typescript
   * // Generic attachment
   * res.attachment();
   *
   * // With filename (sets content-type automatically)
   * res.attachment('report.pdf');
   * // Sets: Content-Disposition: attachment; filename="report.pdf"
   * //       Content-Type: application/pdf
   * ```
   */
  attachment(filename?: string): this {
    if (filename) {
      // Set content-type based on file extension
      this.type(filename);
    }

    // Use content-disposition package for proper RFC 2616/5987 escaping
    this.setHeader('content-disposition', contentDisposition(filename));

    return this;
  }

  /**
   * Set Location header
   *
   * Sets the Location header for redirects or resource location.
   *
   * **Security**: Validates the URL to prevent HTTP Response Splitting attacks
   * by rejecting URLs containing CR/LF characters or their percent-encoded variants.
   *
   * @param url - URL to set in Location header
   * @returns this for chaining
   * @throws Error if URL contains control characters (CRLF injection attempt)
   *
   * @example
   * ```typescript
   * res.location('/new-path').status(201).send();
   * res.location('https://example.com/resource');
   * ```
   */
  location(url: string): this {
    // Validate URL to prevent HTTP Response Splitting (CRLF injection)
    // Check for literal CR/LF and percent-encoded variants (%0d, %0a, %0D, %0A)
    if (/[\r\n]|%0[dDaA]/.test(url)) {
      throw new Error(
        'Invalid URL: control characters are not allowed in Location header (potential CRLF injection)'
      );
    }

    return this.setHeader('location', url);
  }

  /**
   * Redirect to a URL
   *
   * Sends a redirect response with the specified status code and URL.
   * Default status code is 302 (Found).
   *
   * @param url - URL to redirect to
   * @param status - HTTP status code (default: 302)
   *
   * @example
   * ```typescript
   * // 302 redirect
   * res.redirect('/login');
   *
   * // 301 permanent redirect
   * res.redirect('/new-location', 301);
   *
   * // 303 See Other
   * res.redirect('/success', 303);
   * ```
   */
  redirect(url: string, status = 302): void {
    this.status(status);
    this.location(url);
    this.send();
  }

  /**
   * Check if response is finished
   */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Check if response is aborted
   */
  get isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Get current status code
   */
  get statusCodeValue(): number {
    return this.statusCode;
  }
}
