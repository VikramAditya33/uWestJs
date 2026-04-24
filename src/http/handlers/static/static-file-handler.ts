import * as fs from 'fs';
import * as path from 'path';
import rangeParser from 'range-parser';
import ms from 'ms';
import mime from 'mime-types';
import etag from 'etag';
import type { UwsRequest } from '../../core/request';
import type { UwsResponse } from '../../core/response';
import type { FileWorkerPool } from './file-worker-pool';

/**
 * Size threshold for using worker threads (768KB)
 * Files smaller than this will be read using workers
 * Files larger will be streamed directly
 */
const WORKER_THRESHOLD = 768 * 1024;

/**
 * Get first value from string or array
 */
function getFirstValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse HTTP date string to timestamp
 */
function parseHttpDate(date: string): number {
  return Date.parse(date);
}

/**
 * Check if ETag matches any of the provided ETags using weak comparison
 * This implements RFC 7232 weak comparison semantics for If-None-Match.
 * Do NOT use for If-Match, which requires strong comparison.
 */
function matchesETag(etag: string, matches: string[]): boolean {
  return matches.some((match) => match === etag || match === `W/${etag}` || `W/${match}` === etag);
}

/**
 * Options for static file serving
 */
export interface StaticFileOptions {
  /**
   * Root directory for serving files
   */
  root: string;

  /**
   * Max age for cache-control header in milliseconds or string format
   * Supports: '1d', '2h', '30m', '5s', or number in milliseconds
   * @default 0
   */
  maxAge?: number | string;

  /**
   * Enable or disable ETag generation
   *
   * - `true` or `'weak'`: Generate weak ETags (W/"...") based on file stats (default, fast)
   * - `'strong'`: Generate strong ETags based on file stats (supports If-Range for resumable downloads)
   * - `false`: Disable ETag generation
   *
   * ETags are used for HTTP caching and conditional requests:
   * - Weak ETags work with If-None-Match (304 Not Modified responses)
   * - Strong ETags work with If-Match, If-None-Match, and If-Range (resumable downloads)
   *
   * The difference:
   * - Weak: W/"size-mtime" - Fast, suitable for most caching scenarios
   * - Strong: "size-mtime" - Required for byte-range requests with If-Range header
   *
   * @default true
   */
  etag?: boolean | 'weak' | 'strong';

  /**
   * Enable or disable Last-Modified header
   * @default true
   */
  lastModified?: boolean;

  /**
   * Enable or disable Accept-Ranges header for partial content
   * @default true
   */
  acceptRanges?: boolean;

  /**
   * Enable or disable Cache-Control header
   * @default true
   */
  cacheControl?: boolean;

  /**
   * How to handle dotfiles (files/directories starting with .)
   * - 'allow': Serve dotfiles normally
   * - 'deny': Return 403 Forbidden for dotfiles
   * - 'ignore': Return 404 Not Found for dotfiles
   * - 'ignore_files': Ignore dotfiles in path but allow dotfile as final filename
   * @default 'ignore'
   */
  dotfiles?: 'allow' | 'deny' | 'ignore' | 'ignore_files';

  /**
   * Enable immutable directive in cache-control
   * @default false
   */
  immutable?: boolean;

  /**
   * Custom headers to set on response
   */
  headers?: Record<string, string>;

  /**
   * Function to set custom headers
   */
  setHeaders?: (res: UwsResponse, filePath: string, stat: fs.Stats) => void;

  /**
   * Custom ETag generation function
   *
   * By default, ETags are generated using the industry-standard `etag` package,
   * which creates ETags based on file statistics (size and modification time).
   *
   * You can provide a custom function to override the default behavior.
   * For example, to generate content-based ETags using file hashing:
   *
   * ```ts
   * etagFn: (stat) => {
   *   const hash = crypto.createHash('md5').update(fileContent).digest('hex');
   *   return `"${hash}"`;
   * }
   * ```
   *
   * Note: Content-based ETags require reading the entire file, which impacts performance.
   * The default stat-based approach is much faster and suitable for most use cases.
   */
  etagFn?: (stat: fs.Stats) => string;

  /**
   * Worker pool for reading small files
   * If provided, files smaller than 768KB will be read using workers
   */
  workerPool?: FileWorkerPool;
}

/**
 * Regular expression to detect path traversal attempts
 */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Handler for serving static files with proper caching, range requests, and security
 */
export class StaticFileHandler {
  private readonly options: {
    root: string;
    maxAge: number;
    etag: boolean | 'weak' | 'strong';
    lastModified: boolean;
    acceptRanges: boolean;
    cacheControl: boolean;
    dotfiles: 'allow' | 'deny' | 'ignore' | 'ignore_files';
    immutable: boolean;
    headers: Record<string, string>;
    setHeaders: (res: UwsResponse, filePath: string, stat: fs.Stats) => void;
    etagFn?: (stat: fs.Stats) => string;
    workerPool?: FileWorkerPool;
  };

  constructor(options: StaticFileOptions) {
    // Parse maxAge if it's a string
    let maxAge: number = 0;
    if (typeof options.maxAge === 'string') {
      const parsed = ms(options.maxAge as ms.StringValue);
      maxAge = typeof parsed === 'number' ? parsed : 0;
    } else if (typeof options.maxAge === 'number') {
      maxAge = options.maxAge;
    }

    // Normalize etag option: true -> 'weak', false -> false
    const etag = options.etag === undefined || options.etag === true ? 'weak' : options.etag;

    this.options = {
      root: path.resolve(options.root),
      maxAge,
      etag,
      lastModified: options.lastModified ?? true,
      acceptRanges: options.acceptRanges ?? true,
      cacheControl: options.cacheControl ?? true,
      dotfiles: options.dotfiles ?? 'ignore',
      immutable: options.immutable ?? false,
      headers: options.headers ?? {},
      setHeaders: options.setHeaders ?? (() => {}),
      etagFn: options.etagFn,
      workerPool: options.workerPool,
    };
  }

  /**
   * Serve a static file
   */
  async serve(req: UwsRequest, res: UwsResponse, filePath: string): Promise<void> {
    try {
      // Validate and resolve path
      const decodedPath = this.validateAndDecodePath(filePath, res);
      if (decodedPath === null) return; // Response already sent

      const fullPath = this.resolveAndValidatePath(decodedPath, res);
      if (fullPath === null) return; // Response already sent

      // Get file stats and resolve symlinks
      const fileInfo = await this.getFileStat(fullPath, res);
      if (fileInfo === null) return; // Response already sent

      const { realPath, stat } = fileInfo;

      // Set response headers (use realPath for MIME type detection)
      this.setResponseHeaders(res, realPath, stat);

      // Check preconditions and conditional requests
      if (this.isPreconditionFailure(req, res)) {
        res.status(412).send('Precondition Failed');
        return;
      }

      if (this.isNotModified(req, res)) {
        res.status(304).send();
        return;
      }

      // Handle HEAD requests
      if (req.method === 'HEAD') {
        res.setHeader('content-length', stat.size.toString());
        res.send();
        return;
      }

      // Handle range requests
      if (this.options.acceptRanges && req.headers['range']) {
        if (!this.isRangeFresh(req, res)) {
          await this.serveFullFile(res, realPath, stat);
          return;
        }

        await this.serveRanges(req, res, realPath, stat);
        return;
      }

      // Serve full file
      await this.serveFullFile(res, realPath, stat);
    } catch (err) {
      // Log unexpected errors for debugging
      console.error('Static file serving failed:', { filePath, error: err });

      // If headers not sent, send error response
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  }

  /**
   * Validate and decode the file path
   * Returns null if validation fails (response already sent)
   */
  private validateAndDecodePath(filePath: string, res: UwsResponse): string | null {
    // Decode URI component (HTTP paths are already URL-encoded)
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(filePath);
    } catch {
      res.status(400).send('Bad Request');
      return null;
    }

    // Check for null bytes
    if (decodedPath.includes('\0')) {
      res.status(400).send('Bad Request');
      return null;
    }

    // Check for path traversal
    if (UP_PATH_REGEXP.test(decodedPath)) {
      res.status(403).send('Forbidden');
      return null;
    }

    return decodedPath;
  }

  /**
   * Resolve and validate the full file path
   * Returns null if validation fails (response already sent)
   */
  private resolveAndValidatePath(decodedPath: string, res: UwsResponse): string | null {
    // Resolve full path
    const fullPath = path.resolve(path.join(this.options.root, decodedPath));

    // Security check - prevent directory traversal
    // Root is already resolved in constructor, no need to resolve again
    if (fullPath !== this.options.root && !fullPath.startsWith(this.options.root + path.sep)) {
      res.status(403).send('Forbidden');
      return null;
    }

    // Check dotfiles
    const parts = path.normalize(decodedPath).split(path.sep);
    if (this.containsDotFile(parts)) {
      switch (this.options.dotfiles) {
        case 'allow':
          break;
        case 'deny':
          res.status(403).send('Forbidden');
          return null;
        case 'ignore_files': {
          // Block if there are dotfiles in the path (not just the filename)
          const len = parts.length;
          for (let i = 0; i < len - 1; i++) {
            if (parts[i].length > 1 && parts[i][0] === '.') {
              res.status(404).send('Not Found');
              return null;
            }
          }
          break;
        }
        case 'ignore':
        default:
          res.status(404).send('Not Found');
          return null;
      }
    }

    return fullPath;
  }

  /**
   * Get file stats with symlink resolution and security validation
   * Returns null if file doesn't exist, is not a file, or symlink escapes root (response already sent)
   * Returns both the resolved real path and stats to prevent TOCTOU issues
   */
  private async getFileStat(
    fullPath: string,
    res: UwsResponse
  ): Promise<{ realPath: string; stat: fs.Stats } | null> {
    // Resolve symlinks to get the real path
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(fullPath);
    } catch {
      // File doesn't exist or can't be resolved
      res.status(404).send('Not Found');
      return null;
    }

    // Re-validate that the resolved path is still within root
    // This prevents symlink traversal attacks where a symlink inside root points outside
    if (realPath !== this.options.root && !realPath.startsWith(this.options.root + path.sep)) {
      res.status(403).send('Forbidden');
      return null;
    }

    // Get file stats using the resolved path
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(realPath);
    } catch {
      res.status(404).send('Not Found');
      return null;
    }

    // Check if it's a file (not a directory)
    if (!stat.isFile()) {
      res.status(404).send('Not Found');
      return null;
    }

    return { realPath, stat };
  }

  /**
   * Set all response headers (content-type, cache, etag, etc.)
   */
  private setResponseHeaders(res: UwsResponse, fullPath: string, stat: fs.Stats): void {
    // Set content-type using mime-types package
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    res.type(mimeType);

    // Set cache headers
    if (this.options.cacheControl && this.options.maxAge >= 0) {
      const maxAgeSeconds = Math.floor(this.options.maxAge / 1000);
      const cacheControl = `public, max-age=${maxAgeSeconds}${
        this.options.immutable ? ', immutable' : ''
      }`;
      res.setHeader('cache-control', cacheControl);
    }

    // Set last-modified
    if (this.options.lastModified) {
      res.setHeader('last-modified', stat.mtime.toUTCString());
    }

    // Set ETag header
    // Uses the industry-standard etag package for efficient ETag generation
    // Weak ETags (W/"...") are used by default, strong ETags omit the W/ prefix
    if (this.options.etag) {
      const etagValue = this.options.etagFn
        ? this.options.etagFn(stat)
        : etag(stat, { weak: this.options.etag !== 'strong' });
      res.setHeader('etag', etagValue);
    }

    // Set accept-ranges header
    if (this.options.acceptRanges) {
      res.setHeader('accept-ranges', 'bytes');
    }

    // Set custom headers
    for (const [key, value] of Object.entries(this.options.headers)) {
      res.setHeader(key, value);
    }

    // Call custom setHeaders function
    this.options.setHeaders(res, fullPath, stat);
  }

  /**
   * Serve the full file
   * Uses worker threads for small files if worker pool is available
   */
  private async serveFullFile(res: UwsResponse, filePath: string, stat: fs.Stats): Promise<void> {
    res.setHeader('content-length', stat.size.toString());

    // Use worker pool for small files if available
    if (
      this.options.workerPool &&
      this.options.workerPool.size > 0 &&
      stat.size < WORKER_THRESHOLD
    ) {
      try {
        const data = await this.options.workerPool.readFile(filePath);
        res.send(data);
        return;
      } catch (err) {
        // Fall back to streaming if worker fails
        console.warn('Worker pool read failed, falling back to stream:', { filePath, error: err });
      }
    }

    // Stream file for large files or if worker pool not available
    const stream = fs.createReadStream(filePath);
    await res.stream(stream, stat.size);
  }

  /**
   * Serve range(s) of the file (partial content)
   * Supports both single and multiple ranges
   */
  private async serveRanges(
    req: UwsRequest,
    res: UwsResponse,
    filePath: string,
    stat: fs.Stats
  ): Promise<void> {
    // Parse range header
    const rangeStr = getFirstValue(req.headers['range']);

    if (!rangeStr) {
      await this.serveFullFile(res, filePath, stat);
      return;
    }

    // Parse ranges using range-parser
    const ranges = rangeParser(stat.size, rangeStr, { combine: true });

    // Unsatisfiable range (e.g., start >= size) → 416 per RFC 7233
    if (ranges === -1) {
      res.status(416);
      res.setHeader('content-range', `bytes */${stat.size}`);
      res.send('Range Not Satisfiable');
      return;
    }

    // Malformed Range header → ignore and serve the full resource
    if (ranges === -2) {
      await this.serveFullFile(res, filePath, stat);
      return;
    }

    // We only support single ranges (combined)
    // Multi-part ranges would require multipart/byteranges response
    if (ranges.length !== 1) {
      // Fall back to full file for multi-range requests
      await this.serveFullFile(res, filePath, stat);
      return;
    }

    const range = ranges[0];
    const { start, end } = range;
    const length = end - start + 1;

    // Set range headers
    res.status(206);
    res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('content-length', length.toString());

    // Stream range
    const stream = fs.createReadStream(filePath, { start, end });
    await res.stream(stream, length);
  }

  /**
   * Check if request has a precondition failure
   * Handles If-Match and If-Unmodified-Since headers
   */
  private isPreconditionFailure(req: UwsRequest, res: UwsResponse): boolean {
    const ifMatchStr = getFirstValue(req.headers['if-match']);

    // Check If-Match (RFC 7232 Section 3.1 - requires strong comparison)
    if (ifMatchStr) {
      // Per RFC 7232 §3.1, `If-Match: *` succeeds if server has any representation
      if (ifMatchStr === '*') return false;

      const etag = res.getHeader('etag') as string;
      if (!etag) return true;

      // If-Match with weak ETag always fails (strong comparison required)
      if (etag.startsWith('W/')) return true;

      // Parse token list and filter out weak ETags (strong comparison)
      const matches = this.parseTokenList(ifMatchStr);
      const strongMatches = matches.filter((m) => !m.startsWith('W/'));

      // Strong comparison: exact match only, no weak ETags allowed
      if (!strongMatches.includes(etag)) return true;
    }

    // Check If-Unmodified-Since
    const ifUnmodifiedSinceStr = getFirstValue(req.headers['if-unmodified-since']);
    if (ifUnmodifiedSinceStr) {
      const unmodifiedTime = parseHttpDate(ifUnmodifiedSinceStr);
      if (!isNaN(unmodifiedTime)) {
        const lastModified = res.getHeader('last-modified') as string;
        if (lastModified) {
          const modifiedTime = parseHttpDate(lastModified);
          if (!isNaN(modifiedTime) && modifiedTime > unmodifiedTime) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if resource has not been modified
   * Handles If-None-Match and If-Modified-Since headers
   */
  private isNotModified(req: UwsRequest, res: UwsResponse): boolean {
    const ifNoneMatchStr = getFirstValue(req.headers['if-none-match']);
    const etag = res.getHeader('etag') as string;

    // Check If-None-Match (takes precedence)
    if (ifNoneMatchStr) {
      if (!etag) return false;
      if (ifNoneMatchStr === '*') return true;

      // Parse token list and check for match
      const matches = this.parseTokenList(ifNoneMatchStr);
      return matchesETag(etag, matches);
    }

    // Check If-Modified-Since
    const ifModifiedSinceStr = getFirstValue(req.headers['if-modified-since']);
    const lastModified = res.getHeader('last-modified') as string;

    if (ifModifiedSinceStr && lastModified) {
      const modifiedTime = parseHttpDate(lastModified);
      const requestTime = parseHttpDate(ifModifiedSinceStr);

      if (!isNaN(modifiedTime) && !isNaN(requestTime)) {
        return modifiedTime <= requestTime;
      }
    }

    return false;
  }

  /**
   * Check if range is still fresh (for If-Range header)
   */
  private isRangeFresh(req: UwsRequest, res: UwsResponse): boolean {
    const ifRangeStr = getFirstValue(req.headers['if-range']);
    if (!ifRangeStr) return true;

    // If-Range as ETag
    if (ifRangeStr.includes('"')) {
      const etag = res.getHeader('etag') as string;
      // If-Range requires strong comparison per RFC 7233
      // Weak ETags (W/"...") never match for If-Range (neither server nor client)
      if (!etag || etag.startsWith('W/') || ifRangeStr.startsWith('W/')) return false;
      return etag === ifRangeStr;
    }

    // If-Range as modified date
    const lastModified = res.getHeader('last-modified') as string;
    if (!lastModified) return false;

    const modifiedTime = parseHttpDate(lastModified);
    const rangeTime = parseHttpDate(ifRangeStr);

    return !isNaN(modifiedTime) && !isNaN(rangeTime) && modifiedTime <= rangeTime;
  }

  /**
   * Check if path contains dotfiles
   */
  private containsDotFile(parts: string[]): boolean {
    for (const part of parts) {
      if (part.length > 1 && part[0] === '.') {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse comma-separated token list
   * Handles quoted strings properly (e.g., "foo,bar", "baz")
   */
  /**
   * Parse comma-separated token list, handling quoted strings
   * @param str - Token list string (e.g., 'W/"123", "456"')
   * @returns Array of tokens
   */
  private parseTokenList(str: string): string[] {
    const list: string[] = [];
    let i = 0;
    const len = str.length;

    while (i < len) {
      i = this.skipWhitespace(str, i, len);
      if (i >= len) break;

      const { token, nextIndex } = this.extractToken(str, i, len);
      if (token) {
        list.push(token);
      }
      i = nextIndex;

      // Skip to next comma
      i = this.skipWhitespace(str, i, len);
      if (i < len && str.charCodeAt(i) === 0x2c) i++; // comma
    }

    return list;
  }

  /**
   * Skip whitespace characters (space and tab)
   */
  private skipWhitespace(str: string, start: number, len: number): number {
    let i = start;
    while (i < len && (str.charCodeAt(i) === 0x20 || str.charCodeAt(i) === 0x09)) i++;
    return i;
  }

  /**
   * Extract a single token (quoted or unquoted)
   */
  private extractToken(
    str: string,
    start: number,
    len: number
  ): { token: string; nextIndex: number } {
    let i = start;
    let end: number;

    // Handle quoted string
    if (str.charCodeAt(i) === 0x22) {
      // opening quote
      i++;
      while (i < len && str.charCodeAt(i) !== 0x22) i++;
      if (i < len) i++; // skip closing quote
      end = i;
    } else {
      // Handle unquoted token - stop on comma, space, or tab
      while (
        i < len &&
        str.charCodeAt(i) !== 0x2c && // comma
        str.charCodeAt(i) !== 0x20 && // space
        str.charCodeAt(i) !== 0x09 // tab
      )
        i++;
      end = i;
    }

    const token = start !== end ? str.substring(start, end) : '';
    return { token, nextIndex: end };
  }
}
