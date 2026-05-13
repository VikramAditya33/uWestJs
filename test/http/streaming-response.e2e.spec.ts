// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Res, Module, INestApplication } from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';

const TEST_TEMP_DIR = path.join(os.tmpdir(), 'uwestjs-streaming-response-e2e');

// ============================================================================
// Merged Controller
// ============================================================================

@Controller('stream-test')
class StreamTestController {
  // backpressure + abort
  @Get('large')
  async largeStream(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    const stat = fs.statSync(testFilePath);
    res.setHeader('x-is-streamed', 'true');
    await res.stream(fileStream, stat.size);
  }

  // chunked encoding
  @Get('chunked')
  async chunkedStream(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'chunked-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    res.setHeader('x-is-streamed', 'true');
    await res.stream(fileStream);
  }

  // content-length
  @Get('content-length')
  async contentLengthStream(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'cl-file.bin');
    const stats = fs.statSync(testFilePath);
    const fileStream = fs.createReadStream(testFilePath);
    res.setHeader('x-is-streamed', 'true');
    await res.stream(fileStream, stats.size);
  }

  // nodejs piping
  @Get('nodejs-pipe')
  async nodejsPipe(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'pipe-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    res.setHeader('x-is-piped', 'true');
    fileStream.pipe(res);
  }

  @Get('nodejs-pipe-content-length')
  async nodejsPipeWithContentLength(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'pipe-file.bin');
    const stats = fs.statSync(testFilePath);
    const fileStream = fs.createReadStream(testFilePath);
    res.setHeader('x-is-piped', 'true');
    res.setHeader('content-length', String(stats.size));
    fileStream.pipe(res);
  }

  // pipeFrom
  @Get('pipefrom')
  async pipeFrom(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'pipefrom-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    res.setHeader('x-is-piped', 'true');
    res.pipeFrom(fileStream);
  }
}

@Module({
  controllers: [StreamTestController],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Response Streaming E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13371;

  beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    // Create all test files upfront
    fs.writeFileSync(
      path.join(TEST_TEMP_DIR, 'large-file.bin'),
      crypto.randomBytes(2 * 1024 * 1024)
    );
    fs.writeFileSync(path.join(TEST_TEMP_DIR, 'chunked-file.bin'), crypto.randomBytes(512 * 1024));
    fs.writeFileSync(path.join(TEST_TEMP_DIR, 'cl-file.bin'), crypto.randomBytes(512 * 1024));
    fs.writeFileSync(path.join(TEST_TEMP_DIR, 'pipe-file.bin'), crypto.randomBytes(512 * 1024));
    fs.writeFileSync(path.join(TEST_TEMP_DIR, 'pipefrom-file.bin'), crypto.randomBytes(512 * 1024));

    const adapter = new UwsPlatformAdapter({ port, maxBodySize: 10 * 1024 * 1024 });
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

    if (fs.existsSync(TEST_TEMP_DIR)) {
      fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Backpressure & abort
  // ==========================================================================

  describe('backpressure and abort', () => {
    it('should stream full data to a slow client without corruption', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            res.pause();
            setTimeout(() => res.resume(), 5);
          });

          res.on('end', () => resolve());
          res.on('error', reject);
        });

        req.on('error', reject);
      });

      const received = Buffer.concat(chunks);
      const receivedHash = crypto.createHash('md5').update(received).digest('hex');

      expect(received.length).toBe(2 * 1024 * 1024);
      expect(receivedHash).toBe(expectedHash);
    }, 15000);

    it('should survive client abort mid-download', async () => {
      let receivedBeforeAbort = 0;

      await new Promise<void>((resolve) => {
        const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
          res.on('data', (chunk: Buffer) => {
            receivedBeforeAbort += chunk.length;
            if (receivedBeforeAbort >= 64 * 1024) {
              res.destroy();
              req.destroy();
              resolve();
            }
          });

          res.on('error', () => resolve());
          res.on('end', () => resolve());
        });

        req.on('error', () => resolve());
      });

      expect(receivedBeforeAbort).toBeGreaterThanOrEqual(64 * 1024);

      await new Promise((r) => setTimeout(r, 300));

      const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const followUp = await new Promise<{ status: number; hash: string }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const req = http.get(`${baseUrl}/stream-test/large`, { agent: false }, (res) => {
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const hash = crypto.createHash('md5').update(body).digest('hex');
            resolve({ status: res.statusCode || 0, hash });
          });
          res.on('error', reject);
        });
        req.on('error', reject);
      });

      expect(followUp.status).toBe(200);
      expect(followUp.hash).toBe(expectedHash);
    }, 15000);
  });

  // ==========================================================================
  // Chunked encoding
  // ==========================================================================

  describe('chunked encoding', () => {
    it('should stream response with chunked transfer encoding (no Content-Length)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'chunked-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/chunked`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-is-streamed')).toBe('true');
      expect(response.headers.get('content-length')).toBeNull();

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(expectedBuffer.byteLength);
    });

    it('should stream large file with chunked encoding (2MB)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'chunked-file.bin');
      const testData = crypto.randomBytes(2 * 1024 * 1024);
      fs.writeFileSync(testFilePath, testData);

      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/chunked`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBeNull();

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(testData.byteLength);
    }, 15000);
  });

  // ==========================================================================
  // Content-Length mode
  // ==========================================================================

  describe('content-length mode', () => {
    it('should stream response with Content-Length header', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'cl-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/content-length`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-is-streamed')).toBe('true');
      expect(response.headers.get('content-length')).toBe(String(expectedBuffer.byteLength));

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(expectedBuffer.byteLength);
    });

    it('should stream large file with Content-Length (2MB)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'cl-file.bin');
      const testData = crypto.randomBytes(2 * 1024 * 1024);
      fs.writeFileSync(testFilePath, testData);

      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/content-length`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(testData.byteLength));

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(testData.byteLength);
    }, 15000);
  });

  // ==========================================================================
  // Node.js piping
  // ==========================================================================

  describe('nodejs piping', () => {
    it('should stream response using standard Node.js readable.pipe(res)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'pipe-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/nodejs-pipe`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-is-piped')).toBe('true');

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(expectedBuffer.byteLength);
    });

    it('should stream with Content-Length when header is set before piping', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'pipe-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/nodejs-pipe-content-length`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-is-piped')).toBe('true');
      expect(response.headers.get('content-length')).toBe(String(expectedBuffer.byteLength));

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(expectedBuffer.byteLength);
    });

    it('should stream large file using Node.js piping (2MB)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'pipe-file.bin');
      const testData = crypto.randomBytes(2 * 1024 * 1024);
      fs.writeFileSync(testFilePath, testData);

      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/nodejs-pipe`);

      expect(response.status).toBe(200);

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(testData.byteLength);
    }, 15000);
  });

  // ==========================================================================
  // pipeFrom convenience
  // ==========================================================================

  describe('pipeFrom', () => {
    it('should stream response using pipeFrom()', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'pipefrom-file.bin');
      const expectedBuffer = fs.readFileSync(testFilePath);
      const expectedHash = crypto.createHash('md5').update(expectedBuffer).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/pipefrom`);

      expect(response.status).toBe(200);
      expect(response.headers.get('x-is-piped')).toBe('true');

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(expectedBuffer.byteLength);
    });

    it('should stream large file using pipeFrom() (2MB)', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'pipefrom-file.bin');
      const testData = crypto.randomBytes(2 * 1024 * 1024);
      fs.writeFileSync(testFilePath, testData);

      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const response = await fetch(`${baseUrl}/stream-test/pipefrom`);

      expect(response.status).toBe(200);

      const receivedBuffer = Buffer.from(await response.arrayBuffer());
      const receivedHash = crypto.createHash('md5').update(receivedBuffer).digest('hex');

      expect(receivedHash).toBe(expectedHash);
      expect(receivedBuffer.byteLength).toBe(testData.byteLength);
    }, 15000);
  });
});
