import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StaticFileHandler } from './static-file-handler';
import { FileWorkerPool } from './file-worker-pool';
import { UwsRequest } from '../../core/request';
import { UwsResponse } from '../../core/response';
import { Readable } from 'stream';

// Helper to create mock UwsRequest
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
}): UwsRequest {
  const req = {
    method: options.method || 'GET',
    url: options.url || '/',
    originalUrl: options.url || '/',
    headers: options.headers || {},
    get: jest.fn((name: string) => {
      const value = (options.headers || {})[name.toLowerCase()];
      return value;
    }),
  } as unknown as UwsRequest;
  return req;
}

// Helper to create mock UwsResponse
function createMockResponse(): { statusCode: number } & Omit<UwsResponse, 'statusCode'> {
  const headers: Record<string, string | string[]> = {};
  let statusCode = 200;

  const res = {
    statusCode,
    headersSent: false,
    status: jest.fn((code: number) => {
      statusCode = code;
      (res as any).statusCode = code;
      return res;
    }),
    setHeader: jest.fn((name: string, value: string | string[]) => {
      headers[name.toLowerCase()] = value;
      return res;
    }),
    getHeader: jest.fn((name: string) => {
      return headers[name.toLowerCase()];
    }),
    type: jest.fn((contentType: string) => {
      headers['content-type'] = contentType;
      return res;
    }),
    send: jest.fn((_data?: any) => {
      (res as any).headersSent = true;
      return res;
    }),
    stream: jest.fn(async (stream: Readable, _size?: number) => {
      (res as any).headersSent = true;
      // Consume the stream
      return new Promise<void>((resolve, reject) => {
        stream.on('data', () => {});
        stream.on('end', resolve);
        stream.on('error', reject);
      });
    }),
  } as any;

  return res;
}

// Helper to serve a file and return response
async function serveFile(
  handler: StaticFileHandler,
  filePath: string,
  options?: {
    method?: string;
    headers?: Record<string, string | string[]>;
  }
): Promise<{ statusCode: number } & Omit<UwsResponse, 'statusCode'>> {
  const req = createMockRequest({
    method: options?.method || 'GET',
    url: filePath,
    headers: options?.headers,
  });
  const res = createMockResponse();
  await handler.serve(req, res as any, filePath);
  return res;
}

// Helper to get ETag for a file
async function getETag(handler: StaticFileHandler, filePath: string): Promise<string> {
  const res = await serveFile(handler, filePath);
  return res.getHeader('etag') as string;
}

describe('StaticFileHandler', () => {
  let handler: StaticFileHandler;
  let testDir: string;
  let testFile: string;
  let testContent: string;

  beforeEach(async () => {
    // Create temporary test directory in system temp with unique name
    testDir = path.join(
      os.tmpdir(),
      `static-file-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.promises.mkdir(testDir, { recursive: true });

    // Create test file
    testContent = 'Hello, World!';
    testFile = path.join(testDir, 'test.txt');
    await fs.promises.writeFile(testFile, testContent);

    // Create handler
    handler = new StaticFileHandler({
      root: testDir,
      maxAge: 3600000, // 1 hour
      etag: true,
      lastModified: true,
      acceptRanges: true,
    });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe('Basic File Serving', () => {
    it('should serve a file successfully', async () => {
      const res = await serveFile(handler, '/test.txt');

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toBe('text/plain');
    });

    it('should handle URL-encoded paths', async () => {
      // Create a file with spaces in the name
      const fileWithSpaces = path.join(testDir, 'test file.txt');
      await fs.promises.writeFile(fileWithSpaces, 'content');

      // Request with URL-encoded path
      const res = await serveFile(handler, '/test%20file.txt');

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toBe('text/plain');
    });

    it('should return 404 for non-existent file', async () => {
      const res = await serveFile(handler, '/nonexistent.txt');

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for directory', async () => {
      const subDir = path.join(testDir, 'subdir');
      await fs.promises.mkdir(subDir);

      const res = await serveFile(handler, '/subdir');

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Security', () => {
    it('should prevent directory traversal with ../', async () => {
      const res = await serveFile(handler, '/../../../etc/passwd');

      expect(res.statusCode).toBe(403);
    });

    it('should prevent directory traversal with absolute path', async () => {
      // Test that traversal attempt is blocked - no need to create actual outside file
      // The handler should reject the path before attempting to access it
      const res = await serveFile(handler, '../outside/secret.txt');
      expect(res.statusCode).toBe(403);
    });

    it('should reject paths with null bytes', async () => {
      const res = await serveFile(handler, '/test\0.txt');

      expect(res.statusCode).toBe(400);
    });

    it('should prevent symlink traversal attacks', async () => {
      // Create a sensitive file outside the root
      const outsideDir = path.join(testDir, '../sensitive');
      await fs.promises.mkdir(outsideDir, { recursive: true });
      const sensitiveFile = path.join(outsideDir, 'secret.txt');
      await fs.promises.writeFile(sensitiveFile, 'SENSITIVE DATA');

      // Create a symlink inside the root pointing to the sensitive file
      const symlinkPath = path.join(testDir, 'link-to-secret');

      try {
        await fs.promises.symlink(sensitiveFile, symlinkPath);
      } catch (err) {
        // Clean up and skip test if symlink creation fails
        await fs.promises.rm(outsideDir, { recursive: true, force: true });

        if ((err as { code?: string }).code === 'EPERM') {
          console.warn(
            'Skipping symlink traversal test: insufficient permissions.\n' +
              'On Windows, run tests as Administrator or enable Developer Mode.\n' +
              'On Linux/Mac, ensure you have permission to create symlinks.'
          );
          return;
        }
        throw err;
      }

      try {
        // Try to access the sensitive file through the symlink
        const res = await serveFile(handler, '/link-to-secret');

        // Should be blocked with 403 Forbidden (not 200 with sensitive data)
        expect(res.statusCode).toBe(403);
      } finally {
        // Clean up - try to unlink the symlink if it exists
        try {
          await fs.promises.unlink(symlinkPath);
        } catch {
          // Ignore if already deleted or doesn't exist
        }
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Dotfiles', () => {
    beforeEach(async () => {
      await fs.promises.writeFile(path.join(testDir, '.hidden'), 'secret');
    });

    it('should ignore dotfiles by default', async () => {
      const res = await serveFile(handler, '/.hidden');

      expect(res.statusCode).toBe(404);
    });

    it('should deny dotfiles when configured', async () => {
      const denyHandler = new StaticFileHandler({ root: testDir, dotfiles: 'deny' });
      const res = await serveFile(denyHandler, '/.hidden');

      expect(res.statusCode).toBe(403);
    });

    it('should allow dotfiles when configured', async () => {
      const allowHandler = new StaticFileHandler({ root: testDir, dotfiles: 'allow' });
      const res = await serveFile(allowHandler, '/.hidden');

      expect(res.statusCode).toBe(200);
    });

    it('should support ignore_files mode', async () => {
      // ignore_files mode blocks dotfiles in path segments (directories)
      // but allows dotfiles as the final filename component

      // Create a dotfile directory with a regular file inside
      const subDir = path.join(testDir, '.subdir');
      await fs.promises.mkdir(subDir);
      await fs.promises.writeFile(path.join(subDir, 'file.txt'), 'content');

      const ignoreFilesHandler = new StaticFileHandler({ root: testDir, dotfiles: 'ignore_files' });

      // Should block access when dotfile appears in path (directory)
      const res1 = await serveFile(ignoreFilesHandler, '/.subdir/file.txt');
      expect(res1.statusCode).toBe(404);

      // Should allow access when dotfile is the final filename component
      const res2 = await serveFile(ignoreFilesHandler, '/.hidden');
      expect(res2.statusCode).toBe(200);
    });
  });

  describe('Cache Headers', () => {
    it('should set cache-control header', async () => {
      const res = await serveFile(handler, '/test.txt');

      expect(res.getHeader('cache-control')).toBe('public, max-age=3600');
    });

    it('should set immutable directive when configured', async () => {
      const immutableHandler = new StaticFileHandler({
        root: testDir,
        maxAge: 3600000,
        immutable: true,
      });
      const res = await serveFile(immutableHandler, '/test.txt');

      expect(res.getHeader('cache-control')).toBe('public, max-age=3600, immutable');
    });

    it('should support string maxAge format', async () => {
      const stringMaxAgeHandler = new StaticFileHandler({ root: testDir, maxAge: '1d' });
      const res = await serveFile(stringMaxAgeHandler, '/test.txt');

      expect(res.getHeader('cache-control')).toBe('public, max-age=86400');
    });

    it('should default to 0 for invalid maxAge string', async () => {
      const invalidMaxAgeHandler = new StaticFileHandler({ root: testDir, maxAge: 'invalid' });
      const res = await serveFile(invalidMaxAgeHandler, '/test.txt');

      expect(res.getHeader('cache-control')).toBe('public, max-age=0');
    });

    it('should not set cache-control when cacheControl is false', async () => {
      const noCacheHandler = new StaticFileHandler({
        root: testDir,
        maxAge: 3600000,
        cacheControl: false,
      });
      const res = await serveFile(noCacheHandler, '/test.txt');

      expect(res.getHeader('cache-control')).toBeUndefined();
    });

    it('should set cache-control with max-age=0', async () => {
      const zeroMaxAgeHandler = new StaticFileHandler({
        root: testDir,
        maxAge: 0,
      });
      const res = await serveFile(zeroMaxAgeHandler, '/test.txt');

      expect(res.getHeader('cache-control')).toBe('public, max-age=0');
    });

    it('should set last-modified header', async () => {
      const res = await serveFile(handler, '/test.txt');

      expect(res.getHeader('last-modified')).toBeDefined();
    });

    it('should set etag header', async () => {
      const res = await serveFile(handler, '/test.txt');
      const etag = res.getHeader('etag');

      expect(etag).toBeDefined();
      expect(etag).toMatch(/^W\//);
    });

    it('should use custom etagFn when provided', async () => {
      const customEtagHandler = new StaticFileHandler({
        root: testDir,
        etagFn: (stat) => `"custom-${stat.size}"`,
      });
      const res = await serveFile(customEtagHandler, '/test.txt');

      expect(res.getHeader('etag')).toBe(`"custom-${testContent.length}"`);
    });
  });

  describe('Conditional Requests', () => {
    it('should return 304 for If-None-Match with matching ETag', async () => {
      const etag = await getETag(handler, '/test.txt');

      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-none-match': etag },
      });

      expect(res.statusCode).toBe(304);
    });

    it('should return 304 for If-Modified-Since with future date', async () => {
      const futureDate = new Date(Date.now() + 86400000).toUTCString();

      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-modified-since': futureDate },
      });

      expect(res.statusCode).toBe(304);
    });

    it('should return 412 for If-Match with non-matching ETag', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-match': '"wrong-etag"' },
      });

      expect(res.statusCode).toBe(412);
    });

    it('should return 412 for If-Match with weak server ETag (RFC 7232)', async () => {
      // Server generates weak ETags by default (W/"...")
      // If-Match requires strong comparison, so weak ETags should always fail
      const etag = await getETag(handler, '/test.txt');

      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-match': etag }, // Even matching weak ETag should fail
      });

      // Should fail because If-Match requires strong comparison
      expect(res.statusCode).toBe(412);
    });

    it('should return 412 for If-Match with weak client ETag (RFC 7232)', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-match': 'W/"some-etag"' }, // Client sends weak ETag
      });

      // Should fail because If-Match requires strong comparison
      expect(res.statusCode).toBe(412);
    });

    it('should return 412 for If-Unmodified-Since with newer file', async () => {
      const pastDate = new Date(Date.now() - 86400000).toUTCString();

      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-unmodified-since': pastDate },
      });

      expect(res.statusCode).toBe(412);
    });
  });

  describe('Range Requests', () => {
    it('should serve partial content for valid range', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=0-4' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.getHeader('content-range')).toMatch(/^bytes 0-4\/\d+$/);
      expect(res.getHeader('content-length')).toBe('5');
    });

    it('should return 416 for invalid range', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=1000-2000' },
      });

      expect(res.statusCode).toBe(416);
      expect(res.getHeader('content-range')).toMatch(/^bytes \*\/\d+$/);
    });

    it('should serve full file for malformed range header', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'invalid-range-header' },
      });

      // Should fall back to serving full file (200, not 416)
      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-length')).toBe(testContent.length.toString());
    });

    it('should handle open-ended range', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=5-' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.getHeader('content-range')).toMatch(/^bytes 5-\d+\/\d+$/);
    });

    it('should set accept-ranges header', async () => {
      const res = await serveFile(handler, '/test.txt');

      expect(res.getHeader('accept-ranges')).toBe('bytes');
    });

    it('should serve full file for If-Range with weak ETag (RFC 7233)', async () => {
      // Weak ETags don't match If-Range per RFC 7233
      const etag = await getETag(handler, '/test.txt');

      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=0-4', 'if-range': etag },
      });

      // Should serve full file (200) because weak ETag doesn't satisfy If-Range
      expect(res.statusCode).toBe(200);
    });

    it('should serve full file for If-Range with client weak ETag', async () => {
      // Client sends weak ETag in If-Range - should be rejected per RFC 7233
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=0-4', 'if-range': 'W/"client-weak-etag"' },
      });

      // Should serve full file (200) because client's weak ETag doesn't satisfy If-Range
      expect(res.statusCode).toBe(200);
    });

    it('should serve full file for If-Range with non-matching ETag', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: 'bytes=0-4', 'if-range': '"wrong-etag"' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should serve partial content with strong ETag and If-Range', async () => {
      // Create handler with strong ETags enabled
      const strongEtagHandler = new StaticFileHandler({
        root: testDir,
        etag: 'strong',
      });

      // First request to get the strong ETag
      const initialRes = await serveFile(strongEtagHandler, '/test.txt');
      const strongEtag = initialRes.getHeader('etag') as string;

      // Verify it's a strong ETag (no W/ prefix)
      expect(strongEtag).toBeDefined();
      expect(strongEtag.startsWith('W/')).toBe(false);

      // Second request with If-Range using the strong ETag
      const rangeRes = await serveFile(strongEtagHandler, '/test.txt', {
        headers: { range: 'bytes=0-4', 'if-range': strongEtag },
      });

      // Should serve partial content (206) because strong ETag satisfies If-Range
      expect(rangeRes.statusCode).toBe(206);
      expect(rangeRes.getHeader('content-range')).toBe('bytes 0-4/13');
    });
  });

  describe('HEAD Requests', () => {
    it('should handle HEAD request', async () => {
      const res = await serveFile(handler, '/test.txt', { method: 'HEAD' });

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-length')).toBeDefined();
      expect(res.getHeader('content-type')).toBe('text/plain');

      // Verify no body content is sent for HEAD requests
      // send() should be called with no arguments (empty body)
      expect(res.send).toHaveBeenCalledWith();
      // stream() should not be called at all
      expect(res.stream).not.toHaveBeenCalled();
    });
  });

  describe('MIME Types', () => {
    it('should set correct MIME type for HTML', async () => {
      const htmlFile = path.join(testDir, 'test.html');
      await fs.promises.writeFile(htmlFile, '<html></html>');

      const res = await serveFile(handler, '/test.html');

      expect(res.getHeader('content-type')).toBe('text/html');
    });

    it('should set correct MIME type for JSON', async () => {
      const jsonFile = path.join(testDir, 'test.json');
      await fs.promises.writeFile(jsonFile, '{}');

      const res = await serveFile(handler, '/test.json');

      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('should set correct MIME type for JavaScript', async () => {
      const jsFile = path.join(testDir, 'test.js');
      await fs.promises.writeFile(jsFile, 'const x = 1;');

      const res = await serveFile(handler, '/test.js');

      expect(res.getHeader('content-type')).toBe('text/javascript');
    });

    it('should set correct MIME type for source maps', async () => {
      const mapFile = path.join(testDir, 'test.js.map');
      await fs.promises.writeFile(mapFile, '{"version":3}');

      const res = await serveFile(handler, '/test.js.map');

      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('should set correct MIME type for WASM', async () => {
      const wasmFile = path.join(testDir, 'test.wasm');
      await fs.promises.writeFile(wasmFile, Buffer.from([0x00, 0x61, 0x73, 0x6d]));

      const res = await serveFile(handler, '/test.wasm');

      expect(res.getHeader('content-type')).toBe('application/wasm');
    });

    it('should set correct MIME type for AVIF', async () => {
      const avifFile = path.join(testDir, 'test.avif');
      await fs.promises.writeFile(avifFile, Buffer.from([0x00]));

      const res = await serveFile(handler, '/test.avif');

      expect(res.getHeader('content-type')).toBe('image/avif');
    });

    it('should use default MIME type for unknown extensions', async () => {
      const unknownFile = path.join(testDir, 'test.unknown');
      await fs.promises.writeFile(unknownFile, 'data');

      const res = await serveFile(handler, '/test.unknown');

      expect(res.getHeader('content-type')).toBe('application/octet-stream');
    });
  });

  describe('Custom Headers', () => {
    it('should set custom headers from options', async () => {
      const customHandler = new StaticFileHandler({
        root: testDir,
        headers: { 'x-custom-header': 'custom-value' },
      });

      const res = await serveFile(customHandler, '/test.txt');

      expect(res.getHeader('x-custom-header')).toBe('custom-value');
    });

    it('should call setHeaders function', async () => {
      const setHeaders = jest.fn();
      const customHandler = new StaticFileHandler({ root: testDir, setHeaders });

      await serveFile(customHandler, '/test.txt');

      expect(setHeaders).toHaveBeenCalledWith(
        expect.anything(), // response object
        expect.stringContaining('test.txt'), // file path
        expect.objectContaining({
          size: expect.any(Number),
          mtimeMs: expect.any(Number),
        }) // stat object (fs.Stats)
      );
    });
  });

  describe('Header Array Values', () => {
    it('should handle If-None-Match as array', async () => {
      const etag = await getETag(handler, '/test.txt');

      const res = await serveFile(handler, '/test.txt', {
        headers: { 'if-none-match': [etag, '"other-etag"'] },
      });

      expect(res.statusCode).toBe(304);
    });

    it('should handle Range as array', async () => {
      const res = await serveFile(handler, '/test.txt', {
        headers: { range: ['bytes=0-4', 'bytes=5-9'] },
      });

      expect(res.statusCode).toBe(206);
    });
  });

  describe('Worker Pool', () => {
    let workerPool: FileWorkerPool;

    beforeEach(() => {
      workerPool = new FileWorkerPool(2);
    });

    afterEach(async () => {
      await workerPool.terminate();
    });

    it('should use worker pool for small files', async () => {
      const workerHandler = new StaticFileHandler({ root: testDir, workerPool });
      const res = await serveFile(workerHandler, '/test.txt');

      expect(res.statusCode).toBe(200);
    });

    it('should stream large files even with worker pool', async () => {
      // Create a large file (>768KB)
      const largeFile = path.join(testDir, 'large.bin');
      const largeData = Buffer.alloc(800 * 1024, 'x');
      await fs.promises.writeFile(largeFile, largeData);

      const workerHandler = new StaticFileHandler({ root: testDir, workerPool });
      const res = await serveFile(workerHandler, '/large.bin');

      expect(res.statusCode).toBe(200);
    });

    it('should fall back to streaming if worker fails', async () => {
      // Terminate workers to simulate failure
      await workerPool.terminate();

      const workerHandler = new StaticFileHandler({ root: testDir, workerPool });
      const res = await serveFile(workerHandler, '/test.txt');

      expect(res.statusCode).toBe(200);
    });
  });
});
