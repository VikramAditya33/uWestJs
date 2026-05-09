// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import {
  Controller,
  Post,
  Req,
  Res,
  Module,
  INestApplication,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsRequest } from '../../src/http/core/request';
import { UwsResponse } from '../../src/http/core/response';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Readable } from 'stream';

function md5(buffer: Buffer | string): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Build multipart/form-data body manually
 */
function buildMultipartBody(
  parts: Array<{ name: string; value: Buffer | string; filename?: string }>,
  boundary: string
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
        )
      );
      chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/**
 * Consume a readable stream into a buffer using event-based API.
 * Handles the race where the stream may already be ended before listeners attach.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const readable = stream as Readable & { readableEnded?: boolean };

    // If stream already ended, resolve immediately
    if (readable.readableEnded) {
      resolve(Buffer.concat(chunks));
      return;
    }

    const onData = (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferView));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

@Controller('upload')
class UploadController {
  @Post('single')
  @HttpCode(HttpStatus.OK)
  async singleFile(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    const files: Array<{ name: string; filename: string; hash: string; size: number }> = [];
    const fields: Record<string, string> = {};

    await req.multipart(async (field) => {
      if (field.file) {
        const buffer = await streamToBuffer(field.file.stream);
        files.push({
          name: field.name,
          filename: field.file.filename,
          hash: md5(buffer),
          size: buffer.length,
        });
      } else {
        fields[field.name] = field.value || '';
      }
    });

    res.json({ files, fields });
  }

  @Post('multiple')
  @HttpCode(HttpStatus.OK)
  async multipleFiles(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    const files: Array<{ name: string; filename: string; hash: string; size: number }> = [];
    const fields: Record<string, string> = {};

    await req.multipart(async (field) => {
      if (field.file) {
        const buffer = await streamToBuffer(field.file.stream);
        files.push({
          name: field.name,
          filename: field.file.filename,
          hash: md5(buffer),
          size: buffer.length,
        });
      } else {
        fields[field.name] = field.value || '';
      }
    });

    res.json({ files, fields });
  }

  @Post('mixed')
  @HttpCode(HttpStatus.OK)
  async mixed(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    const files: Array<{ name: string; filename: string; hash: string; size: number }> = [];
    const fields: Record<string, string> = {};

    await req.multipart(async (field) => {
      if (field.file) {
        const buffer = await streamToBuffer(field.file.stream);
        files.push({
          name: field.name,
          filename: field.file.filename,
          hash: md5(buffer),
          size: buffer.length,
        });
      } else {
        fields[field.name] = field.value || '';
      }
    });

    res.json({ files, fields });
  }

  @Post('large')
  @HttpCode(HttpStatus.OK)
  async largeFile(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    const files: Array<{ name: string; filename: string; hash: string; size: number }> = [];

    await req.multipart(async (field) => {
      if (field.file) {
        const buffer = await streamToBuffer(field.file.stream);
        files.push({
          name: field.name,
          filename: field.file.filename,
          hash: md5(buffer),
          size: buffer.length,
        });
      }
    });

    res.json({ files });
  }

  @Post('limits')
  @HttpCode(HttpStatus.OK)
  async withLimits(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    let truncated = false;
    const files: string[] = [];

    await req.multipart(
      {
        limits: {
          fileSize: 1024, // 1KB limit
          files: 2,
        },
      },
      async (field) => {
        if (field.file) {
          const stream = field.file.stream as Readable & { truncated?: boolean };
          await streamToBuffer(stream);
          if (stream.truncated) {
            truncated = true;
          }
          files.push(field.file.filename);
        }
      }
    );

    if (truncated) {
      res.status(413).json({ error: 'Upload limit exceeded' });
    } else {
      res.json({ success: true, files });
    }
  }

  @Post('invalid')
  @HttpCode(HttpStatus.OK)
  async invalid(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    try {
      await req.multipart(async () => {});
      res.json({ success: true });
    } catch (_error) {
      res.status(400).json({ error: 'Invalid multipart request' });
    }
  }
}

@Module({
  controllers: [UploadController],
})
class TestModule {}

describe('Multipart Upload E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13354;

  beforeAll(async () => {
    const adapter = new UwsPlatformAdapter({ port, maxBodySize: 20 * 1024 * 1024 });
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

  function multipartFetch(
    path: string,
    parts: Array<{ name: string; value: Buffer | string; filename?: string }>
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const boundary = '----TestBoundary' + Date.now();
      const body = buildMultipartBody(parts, boundary);

      const options = {
        hostname: 'localhost',
        port,
        path,
        method: 'POST',
        agent: false, // Disable keepalive to prevent connection reuse issues
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Connection: 'close',
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  it('should upload a single file', async () => {
    const content = 'Hello, this is a test file content!';
    const expectedHash = md5(content);

    const response = await multipartFetch('/upload/single', [
      { name: 'file', value: content, filename: 'test.txt' },
    ]);

    expect(response.status).toBe(200);
    const result = response.body as any;

    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('test.txt');
    expect(result.files[0].hash).toBe(expectedHash);
    expect(result.files[0].size).toBe(content.length);
  });

  it('should upload multiple files', async () => {
    const file1 = Buffer.from('First file content');
    const file2 = Buffer.from('Second file content with more data');

    const response = await multipartFetch('/upload/multiple', [
      { name: 'doc1', value: file1, filename: 'doc1.txt' },
      { name: 'doc2', value: file2, filename: 'doc2.txt' },
    ]);

    expect(response.status).toBe(200);
    const result = response.body as any;

    expect(result.files).toHaveLength(2);
    expect(result.files[0].filename).toBe('doc1.txt');
    expect(result.files[0].hash).toBe(md5(file1));
    expect(result.files[1].filename).toBe('doc2.txt');
    expect(result.files[1].hash).toBe(md5(file2));
  });

  it('should handle mixed fields and files', async () => {
    const fileContent = 'Mixed upload test';

    const response = await multipartFetch('/upload/mixed', [
      { name: 'name', value: 'John Doe' },
      { name: 'age', value: '30' },
      { name: 'avatar', value: fileContent, filename: 'avatar.png' },
      { name: 'bio', value: 'Software engineer' },
    ]);

    expect(response.status).toBe(200);
    const result = response.body as any;

    expect(result.fields).toEqual({
      name: 'John Doe',
      age: '30',
      bio: 'Software engineer',
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('avatar.png');
    expect(result.files[0].hash).toBe(md5(fileContent));
  });

  it('should handle large file upload', async () => {
    const size = 2 * 1024 * 1024; // 2MB
    const fileContent = crypto.randomBytes(size);
    const expectedHash = md5(fileContent);

    const response = await multipartFetch('/upload/large', [
      { name: 'largeFile', value: fileContent, filename: 'large.bin' },
    ]);

    expect(response.status).toBe(200);
    const result = response.body as any;

    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('large.bin');
    expect(result.files[0].size).toBe(size);
    expect(result.files[0].hash).toBe(expectedHash);
  });

  it('should reject upload exceeding file size limit', async () => {
    const oversized = crypto.randomBytes(2048); // 2KB > 1KB limit

    const response = await multipartFetch('/upload/limits', [
      { name: 'smallFile', value: oversized, filename: 'too-big.bin' },
    ]);

    expect(response.status).toBe(413);
    const result = response.body as any;
    expect(result.error).toBeDefined();
  });

  it('should reject non-multipart requests', async () => {
    const response = await fetch(`${baseUrl}/upload/invalid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: 'data' }),
    });

    expect(response.status).toBe(400);
  });

  it('should handle client abort mid-upload', async () => {
    // Build a large multipart body so we can abort mid-stream
    const largeBody = crypto.randomBytes(256 * 1024); // 256KB
    const boundary = '----AbortBoundary' + Date.now();
    const fullBody = buildMultipartBody(
      [{ name: 'file', value: largeBody, filename: 'abort-test.bin' }],
      boundary
    );

    // Open a raw HTTP request and write only a small portion
    await new Promise<void>((resolve, _reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port,
          path: '/upload/large',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': fullBody.length,
            Connection: 'close',
          },
        },
        (res) => {
          // We don't expect a complete response; just consume whatever arrives
          res.resume();
          resolve();
        }
      );

      req.on('error', () => {
        // Expected error due to abort
        resolve();
      });

      // Write only the first boundary + headers (partial body), then abort
      const partial = fullBody.subarray(0, Math.min(512, fullBody.length));
      req.write(partial);
      req.destroy();
    });

    // Wait briefly for the server to process the abort
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Follow-up request to verify the server did not crash
    const followUp = await multipartFetch('/upload/single', [
      { name: 'file', value: 'alive-check', filename: 'alive.txt' },
    ]);

    expect(followUp.status).toBe(200);
    const result = followUp.body as any;
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('alive.txt');
  });
});
