// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Res, Module, INestApplication } from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as zlib from 'zlib';
import * as http from 'http';
import { promisify } from 'util';
import { Readable } from 'stream';

const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);
const inflate = promisify(zlib.inflate);

const LARGE_TEXT = 'x'.repeat(2048); // 2KB — above default 1KB threshold
const SMALL_TEXT = 'hello'; // Below threshold

@Controller('compress-test')
class CompressTestController {
  @Get('text')
  text(@Res() res: UwsResponse) {
    res.type('text/plain');
    res.send(LARGE_TEXT);
  }

  @Get('json')
  json(@Res() res: UwsResponse) {
    res.json({ message: LARGE_TEXT });
  }

  @Get('small')
  small(@Res() res: UwsResponse) {
    res.type('text/plain');
    res.send(SMALL_TEXT);
  }

  @Get('image')
  image(@Res() res: UwsResponse) {
    res.type('image/png');
    // Keep payload above threshold so this test isolates content-type behavior
    res.send(Buffer.alloc(2048, 0x61));
  }

  @Get('write-then-stream')
  writeThenStream(@Res() res: UwsResponse) {
    res.type('text/plain');
    res.write('preamble-' + 'x'.repeat(512));
    const stream = Readable.from(['stream-' + 'y'.repeat(1024)]);
    res.stream(stream);
  }
}

@Module({
  controllers: [CompressTestController],
})
class TestModule {}

describe('Response Compression E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13358;

  beforeAll(async () => {
    const adapter = new UwsPlatformAdapter({
      port,
      compress: {
        threshold: 1024,
        level: 6,
        brotli: true,
      },
    });
    app = await NestFactory.create(TestModule, adapter);
    await app.init();

    await new Promise<void>((resolve, reject) => {
      adapter.listen(port, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    baseUrl = `http://localhost:${port}`;
  }, 10000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  function httpGet(
    path: string,
    encoding?: string
  ): Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (encoding) {
        headers['Accept-Encoding'] = encoding;
      }

      const req = http.get(`${baseUrl}${path}`, { agent: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error(`GET ${path} timed out`));
      });
      req.on('error', reject);
    });
  }

  // ============================================================================
  // Gzip
  // ============================================================================

  describe('gzip compression', () => {
    it('should compress text response with gzip', async () => {
      const res = await httpGet('/compress-test/text', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers['vary']).toMatch(/accept-encoding/i);

      const decompressed = await gunzip(res.body);
      expect(decompressed.toString()).toBe(LARGE_TEXT);
    });

    it('should compress json response with gzip', async () => {
      const res = await httpGet('/compress-test/json', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');

      const decompressed = await gunzip(res.body);
      const parsed = JSON.parse(decompressed.toString());
      expect(parsed.message).toBe(LARGE_TEXT);
    });
  });

  // ============================================================================
  // Brotli
  // ============================================================================

  describe('brotli compression', () => {
    it('should compress with brotli when client accepts br', async () => {
      const res = await httpGet('/compress-test/text', 'br');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');

      const decompressed = await brotliDecompress(res.body);
      expect(decompressed.toString()).toBe(LARGE_TEXT);
    });

    it('should prefer brotli over gzip when both accepted', async () => {
      const res = await httpGet('/compress-test/text', 'gzip, deflate, br');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('br');
    });
  });

  // ============================================================================
  // Deflate
  // ============================================================================

  describe('deflate compression', () => {
    it('should compress with deflate when requested', async () => {
      const res = await httpGet('/compress-test/text', 'deflate');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('deflate');

      const decompressed = await inflate(res.body);
      expect(decompressed.toString()).toBe(LARGE_TEXT);
    });
  });

  // ============================================================================
  // No compression
  // ============================================================================

  describe('no compression', () => {
    it('should not compress when Accept-Encoding is missing', async () => {
      const res = await httpGet('/compress-test/text');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(LARGE_TEXT);
    });

    it('should not compress responses below threshold', async () => {
      const res = await httpGet('/compress-test/small', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(SMALL_TEXT);
    });

    it('should not compress non-compressible content types', async () => {
      const res = await httpGet('/compress-test/image', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
    });
  });

  // ============================================================================
  // Streaming with prior write() — regression for mixed-encoding bug
  // ============================================================================

  describe('streaming compression', () => {
    it('should skip compression when write() was already called', async () => {
      const res = await httpGet('/compress-test/write-then-stream', 'gzip');

      expect(res.status).toBe(200);
      // Headers were already sent by write(), so compression must be skipped
      expect(res.headers['content-encoding']).toBeUndefined();

      const text = res.body.toString();
      expect(text.startsWith('preamble-')).toBe(true);
      expect(text.includes('stream-')).toBe(true);
    });
  });

  // ============================================================================
  // Quality values (Accept-Encoding negotiation)
  // ============================================================================

  describe('accept-encoding negotiation', () => {
    it('should respect quality values', async () => {
      // deflate;q=1.0 should win over gzip;q=0.8
      const res = await httpGet('/compress-test/text', 'gzip;q=0.8, deflate;q=1.0');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('deflate');
    });
  });
});
