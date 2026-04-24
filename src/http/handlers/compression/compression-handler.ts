import * as zlib from 'zlib';
import { Transform } from 'stream';
import compressible from 'compressible';
import type { UwsRequest } from '../../core/request';
import type { UwsResponse } from '../../core/response';

/**
 * Compression configuration options
 */
export interface CompressionOptions {
  /**
   * Minimum response size (in bytes) to compress
   * Responses smaller than this will not be compressed
   * @default 1024 (1KB)
   */
  threshold?: number;

  /**
   * Compression level (0-9)
   * - 0: No compression
   * - 1: Fastest compression
   * - 9: Best compression
   *
   * Note: For Brotli, this is mapped to quality 0-11 (level 9 → quality 11)
   * @default 6 (balanced)
   */
  level?: number;

  /**
   * Enable brotli compression (in addition to gzip/deflate)
   * @default false
   */
  brotli?: boolean;

  /**
   * Filter function to determine if response should be compressed
   * Return false to skip compression for specific responses
   * @default undefined (compress all eligible responses)
   */
  filter?: (req: UwsRequest, res: UwsResponse) => boolean;

  /**
   * Enable request body decompression (inflate)
   * Automatically decompresses gzip/deflate/brotli request bodies
   * @default true
   */
  inflate?: boolean;

  /**
   * Maximum size (in bytes) of decompressed request body
   * Protects against decompression bombs (zip bombs)
   * @default 10485760 (10MB)
   */
  maxInflatedBodySize?: number;
}

/**
 * Default compression configuration
 */
const DEFAULT_OPTIONS: Required<Omit<CompressionOptions, 'filter'>> & {
  filter?: CompressionOptions['filter'];
} = {
  threshold: 1024, // 1KB
  level: 6, // Balanced compression
  brotli: false,
  inflate: true,
  maxInflatedBodySize: 10 * 1024 * 1024, // 10MB
  filter: undefined,
};

/**
 * Compression Handler for HTTP requests and responses
 *
 * Provides two-way compression support:
 * 1. Request body decompression (inflate) - Decompresses incoming gzip/deflate/brotli bodies
 * 2. Response body compression - Streaming compression using Transform streams
 *
 * Features:
 * - Automatic content-encoding detection and handling
 * - Configurable compression threshold and level
 * - Support for gzip, deflate, and brotli
 * - Content-type filtering (only compresses compressible types)
 * - Custom filter function support
 * - Non-blocking streaming compression for all response sizes
 *
 * Streaming Compression:
 * - Uses Transform streams (zlib.createGzip, createDeflate, createBrotliCompress)
 * - Non-blocking for all response sizes (never blocks event loop)
 * - Memory efficient for large responses
 * - Works seamlessly with UwsResponse streaming API
 * - Industry standard approach (same as Express compression middleware)
 *
 * @example
 * ```typescript
 * const handler = new CompressionHandler({
 *   threshold: 2048, // Only compress responses > 2KB
 *   level: 9, // Maximum compression
 *   brotli: true, // Enable brotli
 * });
 *
 * // Decompress request body
 * const decompressed = await handler.decompressRequest(req, compressedBody);
 *
 * // Create compression stream for response
 * const compressStream = handler.createCompressionStream(req, res);
 * if (compressStream) {
 *   sourceStream.pipe(compressStream).pipe(res);
 * } else {
 *   sourceStream.pipe(res);
 * }
 *
 * // Compress buffer (for non-streaming responses)
 * const compressed = await handler.compressBuffer(req, res, responseBody);
 * res.send(compressed);
 * ```
 */
export class CompressionHandler {
  private readonly options: Required<Omit<CompressionOptions, 'filter'>> & {
    filter?: CompressionOptions['filter'];
  };

  constructor(options: CompressionOptions = {}) {
    // Validate compression level (0-9 for gzip/deflate, mapped to 0-11 for Brotli)
    const level = options.level ?? DEFAULT_OPTIONS.level;
    if (level < 0 || level > 9) {
      throw new RangeError(
        `Compression level must be between 0 and 9, got ${level}. ` +
          `Note: For Brotli, this is automatically mapped to quality 0-11.`
      );
    }

    const threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
    if (threshold < 0 || !Number.isFinite(threshold)) {
      throw new RangeError(`Threshold must be a non-negative finite number, got ${threshold}`);
    }

    const maxInflatedBodySize = options.maxInflatedBodySize ?? DEFAULT_OPTIONS.maxInflatedBodySize;
    if (maxInflatedBodySize <= 0 || !Number.isFinite(maxInflatedBodySize)) {
      throw new RangeError(
        `maxInflatedBodySize must be a positive finite number, got ${maxInflatedBodySize}`
      );
    }

    this.options = {
      threshold,
      level,
      brotli: options.brotli ?? DEFAULT_OPTIONS.brotli,
      inflate: options.inflate ?? DEFAULT_OPTIONS.inflate,
      maxInflatedBodySize,
      filter: options.filter,
    };
  }

  /**
   * Decompress request body based on Content-Encoding header
   *
   * Supports gzip, deflate, and brotli encodings.
   * Handles multiple encodings by applying decoders in reverse order (last encoding first).
   * Returns original buffer if no compression or if inflate is disabled.
   *
   * @param req - Request object
   * @param body - Compressed request body
   * @returns Decompressed body
   * @throws Error if decompression fails
   */
  async decompressRequest(req: UwsRequest, body: Buffer): Promise<Buffer> {
    // Skip if inflate is disabled
    if (!this.options.inflate) {
      return body;
    }

    // Get content-encoding header
    const contentEncoding = this.getHeader(req.headers['content-encoding']);
    if (!contentEncoding) {
      return body;
    }

    // Parse comma-separated encodings and trim each
    const encodings = contentEncoding
      .split(',')
      .map((encoding) => encoding.trim().toLowerCase())
      .filter(Boolean);

    if (encodings.length === 0) {
      return body;
    }

    try {
      let decompressed = body;
      // Apply decoders in reverse order (last encoding first)
      for (const encoding of [...encodings].reverse()) {
        switch (encoding) {
          case 'gzip':
            decompressed = await this.gunzip(decompressed);
            break;
          case 'deflate':
            decompressed = await this.inflate(decompressed);
            break;
          case 'br':
            decompressed = await this.brotliDecompress(decompressed);
            break;
          case 'identity':
            // No decompression needed
            break;
          default:
            // Unknown encoding - skip it and continue with other encodings
            // This allows partial decompression when some encodings are recognized
            break;
        }
      }
      return decompressed;
    } catch (err) {
      throw new Error(
        `Failed to decompress request body with encoding '${encodings.join(', ')}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  /**
   * Create compression Transform stream for response
   *
   * Creates a Transform stream that compresses data as it flows through.
   * Automatically selects the best compression algorithm based on client's Accept-Encoding header.
   *
   * Checks performed (even without body):
   * - Content-Type must be compressible (prevents compressing images, videos, etc.)
   * - Content must not already be compressed
   * - Custom filter function (if configured)
   *
   * Additional checks when body is provided:
   * - Response size must exceed threshold
   *
   * Sets appropriate Content-Encoding and Vary headers on response.
   *
   * Returns null if compression should not be applied.
   *
   * @param req - Request object
   * @param res - Response object
   * @param body - Optional body to enable size threshold check
   * @returns Transform stream for compression, or null if no compression
   *
   * @example
   * ```typescript
   * // Streaming - automatically checks content-type
   * res.setHeader('content-type', 'text/plain');
   * const compressStream = handler.createCompressionStream(req, res);
   * if (compressStream) {
   *   fs.createReadStream('file.txt').pipe(compressStream).pipe(res);
   * } else {
   *   fs.createReadStream('file.txt').pipe(res);
   * }
   *
   * // With body for full checks including size threshold
   * const body = Buffer.from('data');
   * const compressStream = handler.createCompressionStream(req, res, body);
   * ```
   */
  createCompressionStream(req: UwsRequest, res: UwsResponse, body?: Buffer): Transform | null {
    // Check if compression should be applied (handles both streaming and buffered cases)
    if (!this.shouldCompress(req, res, body)) {
      return null;
    }

    // Get accepted encodings
    const acceptEncoding = this.getHeader(req.headers['accept-encoding']) || '';
    const encodings = this.parseAcceptEncoding(acceptEncoding);

    // Try to create compression stream with the best available encoding
    for (const encoding of encodings) {
      switch (encoding) {
        case 'br':
          if (this.options.brotli) {
            const stream = this.createBrotliCompress();
            res.setHeader('content-encoding', 'br');
            res.removeHeader('content-length');
            this.appendVaryAcceptEncoding(res);
            return stream;
          }
          break;
        case 'gzip': {
          const stream = this.createGzip();
          res.setHeader('content-encoding', 'gzip');
          res.removeHeader('content-length');
          this.appendVaryAcceptEncoding(res);
          return stream;
        }
        case 'deflate': {
          const stream = this.createDeflate();
          res.setHeader('content-encoding', 'deflate');
          res.removeHeader('content-length');
          this.appendVaryAcceptEncoding(res);
          return stream;
        }
      }
    }

    // No suitable encoding found
    return null;
  }

  /**
   * Compress buffer using streaming compression
   *
   * Compresses a buffer by piping it through a Transform stream.
   * This is non-blocking and works efficiently for all buffer sizes.
   *
   * @param req - Request object
   * @param res - Response object
   * @param body - Response body to compress
   * @returns Promise that resolves to compressed buffer (or original if no compression)
   *
   * @example
   * ```typescript
   * // Compress JSON response
   * const json = JSON.stringify({ data: 'value' });
   * const compressed = await handler.compressBuffer(req, res, Buffer.from(json));
   * res.send(compressed);
   * ```
   */
  async compressBuffer(req: UwsRequest, res: UwsResponse, body: Buffer): Promise<Buffer> {
    const stream = this.createCompressionStream(req, res, body);
    if (!stream) {
      return body;
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const compressed = Buffer.concat(chunks);
        // Update Content-Length to match compressed size
        res.setHeader('content-length', compressed.length.toString());
        resolve(compressed);
      });

      stream.on('error', (error: Error) => {
        reject(error);
      });

      // Write body and end stream
      stream.write(body);
      stream.end();
    });
  }

  /**
   * Check if response should be compressed (for streaming without body)
   *
   * Checks content-type, encoding, and custom filter.
   * Does NOT check size threshold (unknown for streams).
   *
   * @param req - Request object
   * @param res - Response object
   * @returns true if should compress, false otherwise
   */
  private shouldCompressStream(req: UwsRequest, res: UwsResponse): boolean {
    // Check if already compressed
    const contentEncoding = res.getHeader('content-encoding');
    if (contentEncoding && contentEncoding !== 'identity') {
      return false;
    }

    // Check content-type (only compress compressible types)
    const contentType = res.getHeader('content-type');
    if (contentType && !this.isCompressible(contentType)) {
      return false;
    }

    // If no content-type, assume compressible (let it through)
    // This matches Express compression middleware behavior

    // Check custom filter
    if (this.options.filter && !this.options.filter(req, res)) {
      return false;
    }

    return true;
  }

  /**
   * Check if response should be compressed (with body for size check)
   *
   * @param req - Request object
   * @param res - Response object
   * @param body - Response body (optional for streaming)
   * @returns true if should compress, false otherwise
   */
  private shouldCompress(req: UwsRequest, res: UwsResponse, body?: Buffer): boolean {
    // Check size threshold only if body is provided
    if (body && body.length < this.options.threshold) {
      return false;
    }

    // Delegate to stream checks for content-type, encoding, and filter
    return this.shouldCompressStream(req, res);
  }

  /**
   * Check if content-type is compressible using the compressible package
   *
   * @param contentType - Content-Type header value
   * @returns true if compressible, false otherwise
   */
  private isCompressible(contentType: string | string[]): boolean {
    const type = this.getHeader(contentType);
    if (!type) {
      return false;
    }

    // Use compressible package for comprehensive MIME type database
    return compressible(type) || false;
  }

  /**
   * Parse Accept-Encoding header and return encodings in preference order
   *
   * Encodings are returned in order of preference:
   * 1. By quality value (highest first)
   * 2. By compression efficiency (br > gzip > deflate for same quality)
   * 3. By position in header (left to right)
   *
   * @param acceptEncoding - Accept-Encoding header value
   * @returns Array of encodings in preference order
   */
  private parseAcceptEncoding(acceptEncoding: string): string[] {
    const encodings: Array<{ encoding: string; quality: number; position: number }> = [];

    // Encoding preference order (higher is better)
    const encodingPriority: Record<string, number> = {
      br: 3, // Brotli - best compression
      gzip: 2, // Gzip - good compression
      deflate: 1, // Deflate - basic compression
    };

    // Parse encodings with quality values
    const parts = acceptEncoding.split(',');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const tokens = part
        .trim()
        .split(';')
        .map((t) => t.trim());
      const encoding = tokens[0];

      // Find q parameter specifically (case-insensitive)
      const qToken = tokens.slice(1).find((t) => t.toLowerCase().startsWith('q='));
      let quality = 1.0;
      if (qToken) {
        const parsed = parseFloat(qToken.split('=')[1]);
        // Clamp to valid range per RFC 7231
        quality = Number.isNaN(parsed) ? 1.0 : Math.min(1, Math.max(0, parsed));
      }

      if (quality > 0) {
        encodings.push({
          encoding: encoding.trim().toLowerCase(),
          quality,
          position: i, // Track position for stable sort
        });
      }
    }

    // Sort by:
    // 1. Quality (highest first)
    // 2. Encoding priority (br > gzip > deflate)
    // 3. Position (earliest first)
    encodings.sort((a, b) => {
      // Compare quality
      if (a.quality !== b.quality) {
        return b.quality - a.quality; // Higher quality first
      }

      // Compare encoding priority
      const aPriority = encodingPriority[a.encoding] || 0;
      const bPriority = encodingPriority[b.encoding] || 0;
      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Higher priority first
      }

      // Compare position
      return a.position - b.position; // Earlier position first
    });

    return encodings.map((e) => e.encoding);
  }

  /**
   * Get header value (handle both string and array)
   *
   * For array values, joins them with comma-space to handle multiple encodings.
   *
   * @param header - Header value
   * @returns String value or undefined
   */
  private getHeader(header: string | string[] | undefined): string | undefined {
    if (!header) {
      return undefined;
    }
    return Array.isArray(header) ? header.join(', ') : header;
  }

  /**
   * Append Accept-Encoding to Vary header without overwriting existing values
   *
   * Properly handles:
   * - Exact token matching (not substring matching)
   * - Preserves Vary: * as-is (wildcard means all headers vary)
   * - Case-insensitive comparison per HTTP spec
   *
   * @param res - Response object
   */
  private appendVaryAcceptEncoding(res: UwsResponse): void {
    const existingVary = res.getHeader('vary');
    if (existingVary) {
      const varyValue = typeof existingVary === 'string' ? existingVary : existingVary.join(', ');

      // Parse existing Vary tokens
      const varyValues = varyValue
        .split(',')
        .map((value: string) => value.trim())
        .filter(Boolean);

      // If Vary: * is present, don't modify (wildcard means all headers vary)
      if (varyValues.includes('*')) {
        return;
      }

      // Only add Accept-Encoding if not already present as a Vary token (case-insensitive)
      if (!varyValues.some((value: string) => value.toLowerCase() === 'accept-encoding')) {
        res.setHeader('vary', `${varyValue}, Accept-Encoding`);
      }
    } else {
      res.setHeader('vary', 'Accept-Encoding');
    }
  }

  /**
   * Create Gzip compression stream
   */
  private createGzip(): Transform {
    return zlib.createGzip({ level: this.options.level });
  }

  /**
   * Create Deflate compression stream
   */
  private createDeflate(): Transform {
    return zlib.createDeflate({ level: this.options.level });
  }

  /**
   * Create Brotli compression stream
   * Maps level 0-9 to Brotli quality 0-11
   */
  private createBrotliCompress(): Transform {
    // Map 0-9 level to Brotli's 0-11 quality range
    const brotliQuality = Math.round((this.options.level / 9) * 11);
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
      },
    });
  }

  /**
   * Gunzip decompression with size limit (async)
   */
  private async gunzip(buffer: Buffer): Promise<Buffer> {
    return this.decompressWithLimit(buffer, zlib.createGunzip());
  }

  /**
   * Inflate decompression with size limit (async)
   */
  private async inflate(buffer: Buffer): Promise<Buffer> {
    return this.decompressWithLimit(buffer, zlib.createInflate());
  }

  /**
   * Brotli decompression with size limit (async)
   */
  private async brotliDecompress(buffer: Buffer): Promise<Buffer> {
    return this.decompressWithLimit(buffer, zlib.createBrotliDecompress());
  }

  /**
   * Decompress buffer using stream with size limit protection
   * Protects against decompression bombs (zip bombs)
   */
  private async decompressWithLimit(buffer: Buffer, decompressor: Transform): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let rejected = false;

      decompressor.on('data', (chunk: Buffer) => {
        if (rejected) return;

        // Check if adding this chunk would exceed limit
        const newSize = totalSize + chunk.length;
        if (newSize > this.options.maxInflatedBodySize) {
          rejected = true;
          const error = new Error(
            `Decompressed body size (${newSize} bytes) exceeds limit (${this.options.maxInflatedBodySize} bytes)`
          );
          decompressor.destroy(error);
          reject(error);
          return;
        }

        totalSize = newSize;
        chunks.push(chunk);
      });

      decompressor.on('end', () => {
        if (!rejected) {
          resolve(Buffer.concat(chunks));
        }
      });

      decompressor.on('error', (err: Error) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      });

      // Write compressed data and end stream
      decompressor.write(buffer);
      decompressor.end();
    });
  }
}
