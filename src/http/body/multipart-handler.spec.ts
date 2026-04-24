import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { UwsRequest } from '../core/request';
import type { MultipartField } from './multipart-handler';
import { MultipartFormHandler } from './multipart-handler';
import { toArrayBuffer } from '../test-helpers';

describe('MultipartFormHandler', () => {
  let mockUwsReq: jest.Mocked<HttpRequest>;
  let mockUwsRes: jest.Mocked<HttpResponse>;
  let headerEntries: Array<[string, string]> = [];
  let onDataCallback: (chunk: ArrayBuffer, isLast: boolean) => void = () => {
    throw new Error('onDataCallback not yet initialized');
  };

  // Helper to create multipart boundary
  const createBoundary = () => '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

  // Helper to create multipart body
  const createMultipartBody = (
    boundary: string,
    fields: Array<{
      name: string;
      value?: string;
      filename?: string;
      content?: string;
      contentType?: string;
    }>
  ) => {
    let body = '';
    for (const field of fields) {
      body += `--${boundary}\r\n`;
      if (field.filename) {
        body += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
        body += `Content-Type: ${field.contentType || 'application/octet-stream'}\r\n\r\n`;
        body += field.content || '';
      } else {
        body += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
        body += field.value || '';
      }
      body += '\r\n';
    }
    body += `--${boundary}--\r\n`;
    return body;
  };

  // Helper to setup request with multipart headers
  const setupMultipartRequest = (boundary: string, bodyLength: number): UwsRequest => {
    headerEntries = [
      ['content-type', `multipart/form-data; boundary=${boundary}`],
      ['content-length', bodyLength.toString()],
    ];
    const req = new UwsRequest(mockUwsReq, mockUwsRes);
    req._initBodyParser(1024 * 1024);
    return req;
  };

  // Helper to send multipart data
  const sendMultipartData = (body: string) => {
    const buffer = Buffer.from(body);
    onDataCallback(toArrayBuffer(buffer), true);
  };

  // Helper to consume file stream and return content
  const consumeFileStream = async (field: MultipartField): Promise<string> => {
    if (!field.file) return '';
    const chunks: Buffer[] = [];
    field.file.stream.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve, reject) => {
      field.file!.stream.on('end', resolve);
      field.file!.stream.on('error', reject);
    });
    return Buffer.concat(chunks).toString();
  };

  beforeEach(() => {
    headerEntries = [];

    mockUwsReq = {
      getMethod: jest.fn(() => 'post'),
      getUrl: jest.fn(() => '/upload'),
      getQuery: jest.fn(() => ''),
      forEach: jest.fn((callback) => {
        headerEntries.forEach(([key, value]) => callback(key, value));
      }),
      getParameter: jest.fn((index: number) => `param${index}`),
    } as unknown as jest.Mocked<HttpRequest>;

    mockUwsRes = {
      onData: jest.fn((callback) => {
        onDataCallback = callback;
        return mockUwsRes;
      }),
      onAborted: jest.fn(() => mockUwsRes),
      pause: jest.fn(() => mockUwsRes),
      resume: jest.fn(() => mockUwsRes),
      close: jest.fn(() => mockUwsRes),
    } as unknown as jest.Mocked<HttpResponse>;
  });

  describe('basic multipart parsing', () => {
    it('should parse simple text fields', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'name', value: 'Vikram Aditya' },
        { name: 'email', value: 'vikram@example.com' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        fields.push(field);
      });

      sendMultipartData(body);
      await parsePromise;

      expect(fields).toHaveLength(2);
      expect(fields[0]).toMatchObject({ name: 'name', value: 'Vikram Aditya' });
      expect(fields[0].file).toBeUndefined();
      expect(fields[1]).toMatchObject({ name: 'email', value: 'vikram@example.com' });
    });

    it('should parse file fields', async () => {
      const boundary = createBoundary();
      const fileContent = 'Hello, World!';
      const body = createMultipartBody(boundary, [
        { name: 'file', filename: 'test.txt', content: fileContent, contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        if (field.file) {
          const content = await consumeFileStream(field);
          fields.push({ ...field, fileContent: content } as any);
        } else {
          fields.push(field);
        }
      });

      sendMultipartData(body);
      await parsePromise;

      expect(fields).toHaveLength(1);
      expect(fields[0].name).toBe('file');
      expect(fields[0].file).toBeDefined();
      expect(fields[0].file?.filename).toBe('test.txt');
      expect((fields[0] as any).fileContent).toBe(fileContent);
    });

    it('should parse mixed text and file fields', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'title', value: 'My Document' },
        {
          name: 'file',
          filename: 'doc.txt',
          content: 'Document content',
          contentType: 'text/plain',
        },
        { name: 'description', value: 'A test document' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        fields.push(field);
        if (field.file) {
          field.file.stream.resume(); // Consume stream
        }
      });

      sendMultipartData(body);
      await parsePromise;

      expect(fields).toHaveLength(3);
      expect(fields[0]).toMatchObject({ name: 'title', value: 'My Document' });
      expect(fields[1].name).toBe('file');
      expect(fields[1].file?.filename).toBe('doc.txt');
      expect(fields[2]).toMatchObject({ name: 'description', value: 'A test document' });
    });
  });

  describe('field metadata', () => {
    it('should include encoding and mimeType for all fields', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'text', value: 'Hello' },
        { name: 'file', filename: 'test.txt', content: 'Content', contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        fields.push(field);
        if (field.file) field.file.stream.resume();
      });

      sendMultipartData(body);
      await parsePromise;

      expect(fields[0].encoding).toBeDefined();
      expect(fields[0].mimeType).toBeDefined();
      expect(fields[1].encoding).toBeDefined();
      expect(fields[1].mimeType).toBe('text/plain');
    });

    it('should include truncation info for text fields', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [{ name: 'field', value: 'value' }]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        fields.push(field);
      });

      sendMultipartData(body);
      await parsePromise;

      expect(fields[0].truncated).toBeDefined();
      expect(fields[0].truncated?.name).toBe(false);
      expect(fields[0].truncated?.value).toBe(false);
    });
  });

  describe('backpressure handling', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should handle async handlers sequentially', async () => {
      jest.useFakeTimers();

      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'field1', value: 'value1' },
        { name: 'field2', value: 'value2' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const executionOrder: string[] = [];

      const parsePromise = req.multipart(async (field) => {
        executionOrder.push(`${field.name}-start`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push(`${field.name}-end`);
      });

      sendMultipartData(body);
      await jest.runAllTimersAsync();
      await parsePromise;

      // Handlers should execute sequentially (field1 completes before field2 starts)
      expect(executionOrder).toEqual(['field1-start', 'field1-end', 'field2-start', 'field2-end']);

      // Verify pause/resume were called for backpressure
      expect(mockUwsRes.pause).toHaveBeenCalled();
      expect(mockUwsRes.resume).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should handle synchronous handlers without backpressure', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'field1', value: 'value1' },
        { name: 'field2', value: 'value2' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const executionOrder: string[] = [];
      const parsePromise = req.multipart((field) => {
        // Synchronous handler
        executionOrder.push(field.name);
      });

      sendMultipartData(body);
      await parsePromise;

      // Both fields should be processed
      expect(executionOrder).toEqual(['field1', 'field2']);

      // Synchronous handlers don't set multipartPromise, so no explicit backpressure pause
      // However, Readable stream internals may still call pause/resume
    });
  });

  describe('error handling', () => {
    it('should reject when handler throws error', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [{ name: 'field', value: 'value' }]);

      const req = setupMultipartRequest(boundary, body.length);

      const parsePromise = req.multipart(async (_field) => {
        throw new Error('Handler error');
      });

      sendMultipartData(body);

      await expect(parsePromise).rejects.toThrow('Handler error');
    });

    it('should throw error if content-type is not multipart', async () => {
      headerEntries = [
        ['content-type', 'application/json'],
        ['content-length', '100'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      await expect(req.multipart(async (_field) => {})).rejects.toThrow(
        'Cannot parse multipart: Content-Type must be multipart/*, got: application/json'
      );
    });

    it('should return early if request has ended', async () => {
      const boundary = createBoundary();
      const req = setupMultipartRequest(boundary, 0);

      // Simulate a completed request by ending the stream
      // UwsRequest extends Node.js Readable, so we call push(null) to signal EOF
      // This is an internal Readable API that sets readableEnded = true
      // Note: This test is coupled to UwsRequest being a Readable stream
      (req as any).push(null);

      let handlerCalled = false;
      await req.multipart(async (_field) => {
        handlerCalled = true;
      });

      expect(handlerCalled).toBe(false);
    });

    it('should throw error if handler is not provided', async () => {
      const boundary = createBoundary();
      const req = setupMultipartRequest(boundary, 100);

      await expect(req.multipart({} as any)).rejects.toThrow(
        'multipart() requires a handler function'
      );
    });

    it('should reject when boundary parameter is missing', async () => {
      // Set content-type without boundary parameter
      headerEntries = [
        ['content-type', 'multipart/form-data'],
        ['content-length', '100'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      await expect(req.multipart(async (_field) => {})).rejects.toThrow(
        'Invalid multipart Content-Type'
      );
    });

    it('should reject if parse() is called multiple times', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [{ name: 'field', value: 'value' }]);

      const req = setupMultipartRequest(boundary, body.length);

      // Create handler directly to test the guard at handler level
      const handler = new MultipartFormHandler(req);

      // Start first parse
      const parsePromise1 = handler.parse(async (_field: MultipartField) => {});

      // Try to call parse again immediately
      await expect(handler.parse(async (_field: MultipartField) => {})).rejects.toThrow(
        'parse() has already been called'
      );

      // Complete first parse
      sendMultipartData(body);
      await parsePromise1;
    });
  });

  describe('busboy options', () => {
    it('should accept busboy configuration options', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [{ name: 'field', value: 'value' }]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(
        {
          limits: {
            fields: 10,
            fileSize: 1024 * 1024,
          },
        },
        async (field) => {
          fields.push(field);
        }
      );

      sendMultipartData(body);
      await parsePromise;

      expect(fields).toHaveLength(1);
    });

    it('should enforce field count limit', async () => {
      const boundary = createBoundary();
      // Create 3 fields but set limit to 2
      const body = createMultipartBody(boundary, [
        { name: 'field1', value: 'value1' },
        { name: 'field2', value: 'value2' },
        { name: 'field3', value: 'value3' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];

      const parsePromise = req.multipart(
        {
          limits: {
            fields: 2, // Limit to 2 fields
          },
        },
        async (field) => {
          fields.push(field);
        }
      );

      sendMultipartData(body);

      // Should reject with FIELDS_LIMIT_REACHED
      await expect(parsePromise).rejects.toBe('FIELDS_LIMIT_REACHED');
    });

    it('should enforce file size limit', async () => {
      const boundary = createBoundary();
      const largeContent = 'x'.repeat(2000); // 2KB content
      const body = createMultipartBody(boundary, [
        { name: 'file', filename: 'large.txt', content: largeContent, contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];
      let wasTruncated = false;

      const parsePromise = req.multipart(
        {
          limits: {
            fileSize: 1024, // Limit to 1KB
          },
        },
        async (field) => {
          fields.push(field);
          // Consume the stream to trigger size limit
          if (field.file) {
            const chunks: Buffer[] = [];
            for await (const chunk of field.file.stream) {
              chunks.push(chunk);
            }
            // Check truncated after stream is consumed (busboy adds this property)
            wasTruncated = (field.file.stream as any).truncated === true;
          }
        }
      );

      sendMultipartData(body);

      // Busboy's fileSize limit triggers a 'limit' event on the file stream
      // which causes truncation but doesn't reject the parse promise
      // So we just verify the parse completes
      await parsePromise;

      // Verify we received the file field
      expect(fields.length).toBeGreaterThan(0);
      expect(fields[0].file).toBeDefined();
      // Verify truncation occurred due to size limit (checked after stream consumption)
      expect(wasTruncated).toBe(true);
    });

    it('should enforce files count limit', async () => {
      const boundary = createBoundary();
      // Create 3 files but set limit to 2
      const body = createMultipartBody(boundary, [
        { name: 'file1', filename: 'test1.txt', content: 'content1', contentType: 'text/plain' },
        { name: 'file2', filename: 'test2.txt', content: 'content2', contentType: 'text/plain' },
        { name: 'file3', filename: 'test3.txt', content: 'content3', contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      const fields: MultipartField[] = [];

      const parsePromise = req.multipart(
        {
          limits: {
            files: 2, // Limit to 2 files
          },
        },
        async (field) => {
          fields.push(field);
          // Consume file streams
          if (field.file) {
            const chunks: Buffer[] = [];
            for await (const chunk of field.file.stream) {
              chunks.push(chunk);
            }
          }
        }
      );

      sendMultipartData(body);

      // Should reject with FILES_LIMIT_REACHED
      await expect(parsePromise).rejects.toBe('FILES_LIMIT_REACHED');
    });
  });

  describe('stream consumption', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should auto-flush unconsumed file streams', async () => {
      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'file', filename: 'test.txt', content: 'Content', contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      let streamEndPromise: Promise<void> | null = null;
      const parsePromise = req.multipart(async (field) => {
        if (field.file) {
          // Don't consume the stream, but wait for it to end
          streamEndPromise = new Promise<void>((resolve) => {
            field.file!.stream.on('end', resolve);
          });
        }
      });

      sendMultipartData(body);
      await parsePromise;

      // Stream should be auto-flushed - wait for the end event
      expect(streamEndPromise).not.toBeNull();
      await streamEndPromise;
    });

    it('should flush file streams even when handler throws error', async () => {
      jest.useFakeTimers();

      const boundary = createBoundary();
      const body = createMultipartBody(boundary, [
        { name: 'file1', filename: 'test1.txt', content: 'Content1', contentType: 'text/plain' },
        { name: 'file2', filename: 'test2.txt', content: 'Content2', contentType: 'text/plain' },
      ]);

      const req = setupMultipartRequest(boundary, body.length);

      let firstStreamEnded = false;

      const parsePromise = req.multipart(async (field) => {
        if (field.file) {
          // Track when streams end
          field.file.stream.on('end', () => {
            if (field.name === 'file1') {
              firstStreamEnded = true;
            }
          });

          // Throw error on first file without consuming stream
          if (field.name === 'file1') {
            throw new Error('Handler error');
          }
        }
      });

      sendMultipartData(body);

      // Should reject due to handler error
      await expect(parsePromise).rejects.toThrow('Handler error');

      // Wait for streams to be flushed
      await jest.runAllTimersAsync();

      // First stream should be flushed even though handler threw
      expect(firstStreamEnded).toBe(true);
      // Second file might not be processed due to early termination, which is fine
    });
  });
});
