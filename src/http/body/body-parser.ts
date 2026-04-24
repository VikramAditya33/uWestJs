import type { HttpResponse } from 'uWebSockets.js';

/**
 * Buffer watermark for backpressure management
 *
 * When buffered data exceeds this threshold, the parser pauses to prevent
 * excessive memory usage. The parser resumes when the consumer processes
 * the buffered data.
 *
 * @internal Exported for testing purposes
 */
export const BUFFER_WATERMARK = 128 * 1024; // 128KB

/**
 * Body parser modes
 * - awaiting: Buffering chunks until consumer decides what to do
 * - buffering: Actively consuming chunks via callback
 * - streaming: Pushing chunks to readable stream (future)
 */
type ParserMode = 'awaiting' | 'buffering' | 'streaming';

/**
 * Body Parser for uWebSockets.js HTTP requests
 *
 * Handles incoming request body data with support for:
 * - Multiple parsing modes (awaiting, buffering, streaming)
 * - Backpressure management (pause/resume)
 * - Size limit enforcement
 * - Chunked transfer encoding
 * - Efficient memory usage
 *
 * The parser starts in 'awaiting' mode, buffering chunks until the consumer
 * calls buffer() to consume the body. This allows lazy body parsing.
 */
export class BodyParser {
  private mode: ParserMode = 'awaiting';
  private bufferedChunks: Buffer[] = [];
  private receivedBytes = 0;
  private expectedBytes = -1;
  private limitBytes: number;
  private paused = false;
  private flushing = false;
  private isChunkedTransfer = false;
  private passthroughCallback?: (chunk: Buffer, isLast: boolean) => void;
  private received = false;
  private aborted = false;
  private abortError?: Error;
  private pendingReject?: (error: Error) => void;
  private bufferPromise?: Promise<Buffer>;
  private abortCallback?: () => void;

  constructor(
    private readonly uwsRes: HttpResponse,
    headers: Record<string, string | string[]>,
    limitBytes: number
  ) {
    this.limitBytes = limitBytes;

    // Get content-length header (handle both string and array)
    const contentLengthHeader = headers['content-length'];
    const contentLengthStr = Array.isArray(contentLengthHeader)
      ? contentLengthHeader[0]
      : contentLengthHeader;
    const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : 0;

    // Get transfer-encoding header
    // Per RFC 7230, Transfer-Encoding can contain multiple codings (e.g., "gzip, chunked")
    // and multiple Transfer-Encoding headers should be combined
    // We need to check if "chunked" is present anywhere in the value(s)
    const transferEncoding = headers['transfer-encoding'];
    const transferEncodingStr = Array.isArray(transferEncoding)
      ? transferEncoding.join(', ')
      : transferEncoding;
    const isChunked = transferEncodingStr?.toLowerCase().includes('chunked') ?? false;

    // Determine if we have a body to parse
    // Even though it can be NaN, the > 0 check will handle this case and ignore NaN
    if (contentLength > 0 || isChunked) {
      this.expectedBytes = isChunked ? 0 : contentLength;
      this.isChunkedTransfer = isChunked;

      // CRITICAL: Register onAborted handler FIRST to detect client disconnects
      // Without this, promises will hang forever if connection is aborted
      uwsRes.onAborted(() => {
        this.aborted = true;
        this.abortError = new Error('Connection aborted');
        this.flushing = true; // Stop processing chunks

        // Reject pending promise via dedicated abort callback
        if (this.abortCallback) {
          this.abortCallback();
        } else if (this.pendingReject) {
          // Only use pendingReject if abortCallback wasn't set
          this.pendingReject(this.abortError);
          this.pendingReject = undefined;
        }
      });

      // Bind uWS onData handler to receive body chunks
      // CRITICAL: This must be done synchronously in the constructor
      // CRITICAL: Buffer.from(new Uint8Array(chunk)) creates a copy to prevent
      // data corruption when uWS neuters the ArrayBuffer after onData returns
      uwsRes.onData((chunk, isLast) => {
        this.onChunk(Buffer.from(new Uint8Array(chunk)), isLast);
      });
    } else {
      // No body expected - mark as received immediately
      this.received = true;
    }
  }

  /**
   * Handle incoming body chunk from uWS
   *
   * @param chunk - Body chunk data
   * @param isLast - Whether this is the last chunk
   */
  private onChunk(chunk: Buffer, isLast: boolean): void {
    // Skip processing if connection was aborted
    // This prevents race conditions where chunks arrive after abort
    if (this.aborted) {
      return;
    }

    // Ignore empty chunks unless it's the last one
    if (chunk.length === 0 && !isLast) {
      return;
    }

    this.receivedBytes += chunk.length;

    // Enforce size limit
    if (this.receivedBytes > this.limitBytes) {
      this.flushing = true;
      const error = new Error('Body size limit exceeded');

      // Reject any pending promise
      if (this.pendingReject) {
        this.pendingReject(error);
        this.abortCallback = undefined;
        this.pendingReject = undefined;
      }

      this.uwsRes.close();
      return;
    }

    if (!this.flushing) {
      switch (this.mode) {
        case 'awaiting':
          // Buffer chunks until consumer decides what to do
          // Chunk is already a Buffer copy (created in onChunk), no need to copy again
          this.bufferedChunks.push(chunk);

          // Pause if we've buffered too much (prevent excessive memory usage)
          // This prevents excessive memory usage while waiting for consumer
          if (this.receivedBytes > BUFFER_WATERMARK) {
            this.pause();
          }
          break;

        case 'buffering':
          // Pass chunk to consumer callback
          if (this.passthroughCallback) {
            // Chunk is already a Buffer copy (created in onChunk), safe to pass directly
            this.passthroughCallback(chunk, isLast);
          }
          break;

        case 'streaming':
          // Push to readable stream (future implementation)
          // Will be implemented in Phase 3 if needed
          break;
      }
    }

    // Mark as received if this is the last chunk
    if (isLast) {
      this.received = true;
    }
  }

  /**
   * Pause receiving body data
   * Used for backpressure management
   */
  private pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.uwsRes.pause();
    }
  }

  /**
   * Resume receiving body data
   * Used for backpressure management
   */
  private resume(): void {
    if (this.paused) {
      this.paused = false;
      this.uwsRes.resume();
    }
  }

  /**
   * Buffer the entire request body into memory
   *
   * This switches the parser to 'buffering' mode and returns a promise
   * that resolves with the complete body buffer.
   *
   * Multiple calls to buffer() will return the same promise, ensuring
   * all callers receive the same data without re-parsing.
   *
   * @returns Promise that resolves with the complete body buffer
   * @throws Error if connection is aborted or size limit exceeded
   */
  buffer(): Promise<Buffer> {
    // Return cached promise if buffer() was already called
    if (this.bufferPromise) {
      return this.bufferPromise;
    }

    // Check if connection was aborted
    if (this.aborted) {
      return Promise.reject(this.abortError || new Error('Connection aborted'));
    }

    // Check if size limit already exceeded
    if (this.flushing && !this.received) {
      return Promise.reject(new Error('Body size limit exceeded'));
    }

    this.mode = 'buffering';

    // Cache the promise to return for subsequent calls
    this.bufferPromise = new Promise((resolve, reject) => {
      // Set up dedicated abort callback for clean rejection
      this.abortCallback = () => {
        this.abortCallback = undefined;
        this.pendingReject = undefined;
        reject(this.abortError || new Error('Connection aborted'));
      };

      // Store reject callback for size limit errors
      this.pendingReject = reject;

      // Check abort status again inside promise
      if (this.aborted) {
        this.abortCallback = undefined;
        this.pendingReject = undefined;
        return reject(this.abortError || new Error('Connection aborted'));
      }

      // If no body expected, return empty buffer
      if (!this.isChunkedTransfer && this.expectedBytes <= 0) {
        this.abortCallback = undefined;
        this.pendingReject = undefined;
        return resolve(Buffer.alloc(0));
      }

      // If already received all data, flush buffered chunks and return
      if (this.received) {
        this.abortCallback = undefined;
        this.pendingReject = undefined;
        const buffer = this.flushBufferedToBuffer();
        return resolve(buffer);
      }

      // For chunked transfer, we don't know total size upfront
      if (this.isChunkedTransfer) {
        const incomingChunks: Buffer[] = [];

        this.passthroughCallback = (chunk, isLast) => {
          incomingChunks.push(chunk);
          if (isLast) {
            this.abortCallback = undefined;
            this.pendingReject = undefined;
            resolve(Buffer.concat(incomingChunks));
          }
        };

        // Flush buffered chunks
        this.flushBuffered();
      } else {
        // For known content-length, check size limit before allocating
        if (this.expectedBytes > this.limitBytes) {
          const error = new Error('Body size limit exceeded');
          this.abortCallback = undefined;
          this.pendingReject = undefined;
          this.uwsRes.close();
          reject(error);
          return;
        }

        // Allocate exact buffer
        // Use alloc() instead of allocUnsafe() to prevent memory exposure if client
        // sends fewer bytes than Content-Length (premature disconnect)
        const buffer = Buffer.alloc(this.expectedBytes);
        let offset = 0;

        this.passthroughCallback = (chunk, isLast) => {
          // Guard against malformed requests sending more than Content-Length
          const bytesToCopy = Math.min(chunk.length, buffer.length - offset);
          if (bytesToCopy > 0) {
            chunk.copy(buffer, offset, 0, bytesToCopy);
            offset += bytesToCopy;
          }

          if (isLast) {
            this.abortCallback = undefined;
            this.pendingReject = undefined;
            // Return only the filled portion to handle cases where client sends
            // fewer bytes than Content-Length (premature disconnect)
            resolve(offset === buffer.length ? buffer : buffer.subarray(0, offset));
          }
        };

        // Flush buffered chunks
        this.flushBuffered();
      }
    });

    return this.bufferPromise;
  }

  /**
   * Flush buffered chunks to the passthrough callback
   */
  private flushBuffered(): void {
    if (this.bufferedChunks.length > 0) {
      // Capture chunks and clear buffer before processing
      // This prevents issues if callback throws or modifies state
      const chunks = this.bufferedChunks;
      this.bufferedChunks = [];

      try {
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1 && this.received;

          if (this.passthroughCallback) {
            // Chunk is already a Buffer, no need to convert
            this.passthroughCallback(chunks[i], isLast);
          }
        }
      } finally {
        // Always resume, even if callback throws
        // This prevents the stream from being stuck in paused state
        this.resume();
      }
      return;
    }

    // Resume if we had paused due to buffering
    this.resume();
  }

  /**
   * Flush buffered chunks directly to a single buffer
   * Used when body is already fully received
   */
  private flushBufferedToBuffer(): Buffer {
    if (this.bufferedChunks.length === 0) {
      return Buffer.alloc(0);
    }

    // Chunks are already Buffers, use Buffer.concat for efficiency
    const buffer = Buffer.concat(this.bufferedChunks);
    this.bufferedChunks = [];
    return buffer;
  }

  /**
   * Check if body has been fully received
   */
  get isReceived(): boolean {
    return this.received;
  }

  /**
   * Get number of bytes received so far
   */
  get bytesReceived(): number {
    return this.receivedBytes;
  }

  /**
   * Get expected number of bytes
   *
   * @returns -1 if no body expected, 0 for chunked transfer encoding, or the Content-Length value
   */
  get bytesExpected(): number {
    return this.expectedBytes;
  }
}
