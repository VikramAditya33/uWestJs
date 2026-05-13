// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import {
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Module,
  HttpCode,
  HttpStatus,
  INestApplication,
} from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsRequest } from '../../src/http/core/request';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { Writable, PassThrough } from 'stream';

const TEST_TEMP_DIR = path.join(os.tmpdir(), 'uwestjs-streaming-request-e2e');

// ============================================================================
// Merged Controller
// ============================================================================

@Controller('stream-test')
class StreamTestController {
  // backpressure
  @Post('slow-consumer')
  @HttpCode(HttpStatus.OK)
  async slowConsumer(@Req() req: UwsRequest) {
    const chunks: Buffer[] = [];
    let chunkCount = 0;

    const slowWritable = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        chunkCount++;
        if (chunkCount % 3 === 0) {
          setTimeout(callback, 5);
        } else {
          callback();
        }
      },
    });

    req.pipe(slowWritable);

    await new Promise<void>((resolve, reject) => {
      slowWritable.once('finish', resolve);
      slowWritable.once('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    return { hash, size: buffer.length, chunkCount };
  }

  // chunked transfer
  @Post('chunked')
  @HttpCode(HttpStatus.OK)
  async chunkedTransfer(@Req() req: UwsRequest) {
    const fileName = req.headers['x-file-name'] as string;
    const filePath = path.join(TEST_TEMP_DIR, fileName);
    const writable = fs.createWriteStream(filePath);
    req.pipe(writable);

    await new Promise<void>((resolve, reject) => {
      writable.once('finish', resolve);
      writable.once('error', reject);
    });

    const writtenBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(writtenBuffer).digest('hex');
    fs.unlinkSync(filePath);
    return { hash, size: writtenBuffer.length };
  }

  // connection abort
  @Post('abort-test')
  @HttpCode(HttpStatus.OK)
  async abortTest(@Req() req: UwsRequest) {
    const chunks: Buffer[] = [];
    let aborted = false;
    let errorOccurred = false;

    return new Promise((resolve) => {
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (!aborted) {
          resolve({
            success: true,
            bytesReceived: chunks.reduce((sum, c) => sum + c.length, 0),
            aborted: false,
          });
        }
      });

      req.on('error', () => {
        errorOccurred = true;
      });

      req.on('close', () => {
        if (req.isAborted) {
          aborted = true;
          resolve({
            success: true,
            bytesReceived: chunks.reduce((sum, c) => sum + c.length, 0),
            aborted: true,
            errorOccurred,
          });
        }
      });
    });
  }

  // data integrity
  @Post('data-integrity')
  @HttpCode(HttpStatus.OK)
  async dataIntegrity(@Req() req: UwsRequest) {
    const passThrough = new PassThrough();
    const chunks: Buffer[] = [];

    passThrough.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.pipe(passThrough);

    await new Promise<void>((resolve, reject) => {
      passThrough.once('end', resolve);
      passThrough.once('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    return { hash, size: buffer.length };
  }

  // large payload
  @Post('large-payload')
  @HttpCode(HttpStatus.OK)
  async largePayload(@Req() req: UwsRequest) {
    const passthrough = new PassThrough();
    req.pipe(passthrough);

    const chunks: Buffer[] = [];
    passthrough.on('data', (chunk) => {
      chunks.push(chunk);
    });

    await new Promise<void>((resolve) => {
      passthrough.on('end', resolve);
    });

    const body = Buffer.concat(chunks);
    const hash = crypto.createHash('md5').update(body).digest('hex');
    return { hash, size: body.length };
  }

  // non-post methods
  @Get('echo')
  @HttpCode(HttpStatus.OK)
  async getEcho(@Req() req: UwsRequest) {
    const body = await req.buffer();
    const hash = crypto.createHash('md5').update(body).digest('hex');
    return { method: 'GET', hash, size: body.length, echo: body.toString('utf8').substring(0, 50) };
  }

  @Delete('echo')
  @HttpCode(HttpStatus.OK)
  async deleteEcho(@Req() req: UwsRequest) {
    const body = await req.buffer();
    const hash = crypto.createHash('md5').update(body).digest('hex');
    return {
      method: 'DELETE',
      hash,
      size: body.length,
      echo: body.toString('utf8').substring(0, 50),
    };
  }

  // pipe buffer
  @Post('pipe-buffer')
  @HttpCode(HttpStatus.OK)
  async pipeBuffer(@Req() req: UwsRequest) {
    const fileName = req.headers['x-file-name'] as string;
    const filePath = path.join(TEST_TEMP_DIR, fileName);
    const writable = fs.createWriteStream(filePath);
    req.pipe(writable);

    await new Promise<void>((resolve, reject) => {
      writable.once('finish', resolve);
      writable.once('error', reject);
    });

    const writtenBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5').update(writtenBuffer).digest('hex');
    fs.unlinkSync(filePath);
    return { hash, size: writtenBuffer.length };
  }

  // pipe passthrough
  @Post('pipe-passthrough')
  @HttpCode(HttpStatus.OK)
  async pipePassThrough(@Req() req: UwsRequest) {
    const passThrough = new PassThrough();
    const chunks: Buffer[] = [];

    passThrough.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.pipe(passThrough);

    await new Promise<void>((resolve, reject) => {
      passThrough.once('end', resolve);
      passThrough.once('error', reject);
    });

    const buffer = Buffer.concat(chunks);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    return { hash, size: buffer.length };
  }
}

@Module({
  controllers: [StreamTestController],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Request Streaming E2E', () => {
  let app: INestApplication;
  const port = 13370;

  beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    const adapter = new UwsPlatformAdapter({ port, maxBodySize: 20 * 1024 * 1024 });
    app = await NestFactory.create(TestModule, adapter);
    await app.init();

    await new Promise<void>((resolve, reject) => {
      adapter.listen(port, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // baseUrl intentionally omitted — all requests use http.request() with explicit hostname/port
  }, 30000);

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
  // Backpressure
  // ==========================================================================

  describe('backpressure', () => {
    it('should handle backpressure from slow consumer (1MB)', async () => {
      const data = crypto.randomBytes(1024 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/slow-consumer',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(1024 * 1024);
      expect(result.chunkCount).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Chunked transfer encoding
  // ==========================================================================

  describe('chunked transfer encoding', () => {
    it('should handle chunked transfer encoding with file stream', async () => {
      const testFilePath = path.join(TEST_TEMP_DIR, 'source-file.bin');
      const testData = crypto.randomBytes(512 * 1024);
      fs.writeFileSync(testFilePath, testData);

      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const result = await new Promise<{ hash: string; size: number }>((resolve, reject) => {
        const fileStream = fs.createReadStream(testFilePath);

        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/chunked',
          method: 'POST',
          headers: {
            'Transfer-Encoding': 'chunked',
            'Content-Type': 'application/octet-stream',
            'x-file-name': 'chunked-upload.bin',
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        fileStream.pipe(req);
        fileStream.on('error', reject);
      });

      fs.unlinkSync(testFilePath);

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(512 * 1024);
    });
  });

  // ==========================================================================
  // Connection abort
  // ==========================================================================

  describe('connection abort', () => {
    it('should handle connection abort during streaming', async () => {
      let requestDestroyed = false;

      const uploadPromise = new Promise<void>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/abort-test',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            reject(new Error('Request completed instead of being aborted'));
          });
        });

        let resolved = false;
        const safetyTimeout = setTimeout(() => {
          if (!resolved) {
            reject(new Error('Timeout: abort event did not fire'));
          }
        }, 3000);

        req.on('error', (error) => {
          if (resolved) return;
          if (
            error.message.includes('aborted') ||
            error.code === 'ECONNRESET' ||
            error.code === 'EPIPE'
          ) {
            resolved = true;
            clearTimeout(safetyTimeout);
            requestDestroyed = true;
            resolve();
          } else {
            reject(error);
          }
        });

        req.once('close', () => {
          if (resolved) return;
          if (req.destroyed) {
            resolved = true;
            clearTimeout(safetyTimeout);
            requestDestroyed = true;
            resolve();
          }
        });

        const chunkSize = 16 * 1024;
        let sent = 0;
        const totalSize = 5 * 1024 * 1024;
        let chunkCount = 0;

        const sendChunk = () => {
          if (sent >= totalSize || requestDestroyed) {
            if (!requestDestroyed) {
              req.end();
            }
            return;
          }

          const chunk = Buffer.alloc(chunkSize, 'x');
          sent += chunkSize;
          chunkCount++;

          if (chunkCount === 3) {
            setTimeout(() => {
              req.destroy();
            }, 10);
            return;
          }

          if (req.write(chunk)) {
            setTimeout(sendChunk, 20);
          } else {
            req.once('drain', () => setTimeout(sendChunk, 20));
          }
        };

        sendChunk();
      });

      await expect(uploadPromise).resolves.toBeUndefined();
      expect(requestDestroyed).toBe(true);
    });

    it('should complete successfully without abort', async () => {
      const testData = Buffer.alloc(256 * 1024, 'a');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/abort-test',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': testData.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(testData);
        req.end();
      });

      expect(result.success).toBe(true);
      expect(result.aborted).toBe(false);
      expect(result.bytesReceived).toBe(256 * 1024);
    });
  });

  // ==========================================================================
  // Data integrity
  // ==========================================================================

  describe('data integrity', () => {
    it('should maintain data integrity for binary pattern', async () => {
      const data = Buffer.alloc(256 * 1024);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/data-integrity',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(256 * 1024);
    });

    it('should maintain data integrity for random bytes', async () => {
      const data = crypto.randomBytes(512 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/data-integrity',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(512 * 1024);
    });
  });

  // ==========================================================================
  // Large payloads
  // ==========================================================================

  describe('large payloads', () => {
    it('should handle 2MB payload', async () => {
      const data = crypto.randomBytes(2 * 1024 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/large-payload',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(2 * 1024 * 1024);
    }, 15000);

    it('should handle 5MB payload', async () => {
      const data = crypto.randomBytes(5 * 1024 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/large-payload',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(5 * 1024 * 1024);
    }, 20000);
  });

  // ==========================================================================
  // Non-POST methods
  // ==========================================================================

  describe('non-POST methods', () => {
    it('should handle GET request with body (non-standard)', async () => {
      const testData = 'GET request with body data - ' + 'x'.repeat(100);
      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/echo',
          method: 'GET',
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(testData),
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(testData);
        req.end();
      });

      expect(result.method).toBe('GET');
      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(testData.length);
    });

    it('should handle DELETE request with body (non-standard)', async () => {
      const testData = 'DELETE request with body data - ' + 'y'.repeat(100);
      const expectedHash = crypto.createHash('md5').update(testData).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/echo',
          method: 'DELETE',
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(testData),
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(testData);
        req.end();
      });

      expect(result.method).toBe('DELETE');
      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(testData.length);
    });
  });

  // ==========================================================================
  // Pipe buffer
  // ==========================================================================

  describe('pipe buffer', () => {
    it('should pipe 1MB buffer to writable stream', async () => {
      const data = crypto.randomBytes(1024 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/pipe-buffer',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
            'x-file-name': 'test-1mb.bin',
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(1024 * 1024);
    });
  });

  // ==========================================================================
  // Pipe PassThrough
  // ==========================================================================

  describe('pipe passthrough', () => {
    it('should pipe 500KB buffer to PassThrough stream', async () => {
      const data = crypto.randomBytes(500 * 1024);
      const expectedHash = crypto.createHash('md5').update(data).digest('hex');

      const result = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/stream-test/pipe-passthrough',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.length,
          },
          agent: false,
        };

        const req = http.request(options, (res) => {
          let responseData = '';
          res.on('data', (chunk) => {
            responseData += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (_error) {
              reject(new Error(`Failed to parse response: ${responseData}`));
            }
          });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
      });

      expect(result.hash).toBe(expectedHash);
      expect(result.size).toBe(500 * 1024);
    });
  });
});
