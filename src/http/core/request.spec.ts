import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { Writable } from 'stream';
import { UwsRequest } from './request';
import { toArrayBuffer } from '../test-helpers';
import * as signature from 'cookie-signature';
import type { MultipartField } from '../body/multipart-handler';

describe('UwsRequest', () => {
  let mockUwsReq: jest.Mocked<HttpRequest>;
  let mockUwsRes: jest.Mocked<HttpResponse>;
  let headerEntries: Array<[string, string]> = [];
  let onDataCallback: (chunk: ArrayBuffer, isLast: boolean) => void = () => {
    throw new Error('onDataCallback not yet initialized - create BodyParser first');
  };

  // Helper to set headers
  const setHeaders = (...headers: Array<[string, string]>) => {
    headerEntries = headers;
  };

  // Helper to create request with body parser initialized
  const createRequestWithBody = (contentType: string, bodyContent: string) => {
    setHeaders(['content-type', contentType], ['content-length', bodyContent.length.toString()]);
    const req = new UwsRequest(mockUwsReq, mockUwsRes);
    req._initBodyParser(1024 * 1024);
    return { req, bodyContent };
  };

  // Helper to simulate body data arrival
  const sendBody = (bodyContent: string) => {
    const body = Buffer.from(bodyContent);
    onDataCallback(toArrayBuffer(body), true);
  };

  // Helper to create signed cookie value
  const createSignedCookie = (value: string, secret: string) => {
    return 's:' + signature.sign(value, secret);
  };

  // Helper to test body parsing with caching
  const testBodyParsingWithCache = async <T>(
    contentType: string,
    bodyContent: string,
    parseMethod: (req: UwsRequest) => Promise<T>,
    expectedResult: T
  ) => {
    const { req } = createRequestWithBody(contentType, bodyContent);
    const promise = parseMethod(req);
    sendBody(bodyContent);

    const result1 = await promise;
    const result2 = await parseMethod(req);

    expect(result1).toEqual(expectedResult);
    expect(result1).toBe(result2); // Cached - same reference
  };

  beforeEach(() => {
    headerEntries = [];

    mockUwsReq = {
      getMethod: jest.fn(() => 'get'),
      getUrl: jest.fn(() => '/test'),
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

  describe('constructor', () => {
    it('should cache method, url, query from uWS request', () => {
      mockUwsReq.getMethod.mockReturnValue('post');
      mockUwsReq.getUrl.mockReturnValue('/api/users');
      mockUwsReq.getQuery.mockReturnValue('page=1&limit=10');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/users');
      expect(req.path).toBe('/api/users');
      expect(req.query).toBe('page=1&limit=10');
      expect(req.originalUrl).toBe('/api/users?page=1&limit=10');
    });

    it('should cache raw header entries immediately from stack-allocated request', () => {
      headerEntries = [
        ['content-type', 'application/json'],
        ['authorization', 'Bearer token'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      // Raw entries are cached in constructor, so headers getter should work
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['authorization']).toBe('Bearer token');
    });

    it('should cache path parameters', () => {
      const req = new UwsRequest(mockUwsReq, mockUwsRes, ['id', 'action']);

      expect(req.params).toEqual({
        id: 'param0',
        action: 'param1',
      });
    });

    it('should handle empty query string', () => {
      mockUwsReq.getQuery.mockReturnValue('');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.query).toBe('');
      expect(req.originalUrl).toBe('/test');
    });
  });

  describe('headers', () => {
    it('should parse and normalize headers lazily on first access', () => {
      headerEntries = [
        ['content-type', 'application/json'],
        ['accept', 'application/json'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      // Access headers for the first time - triggers parsing
      const headers = req.headers;

      expect(headers['content-type']).toBe('application/json');
      expect(headers['accept']).toBe('application/json');

      // Second access should return cached result (same object reference)
      expect(req.headers).toBe(headers);
    });

    it('should handle duplicate headers with comma concatenation', () => {
      headerEntries = [
        ['accept', 'application/json'],
        ['accept', 'text/html'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.headers['accept']).toBe('application/json, text/html');
    });

    it('should handle cookie headers with semicolon concatenation', () => {
      headerEntries = [
        ['cookie', 'session=abc123'],
        ['cookie', 'user=vikram'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.headers['cookie']).toBe('session=abc123; user=vikram');
    });

    it('should handle set-cookie as array', () => {
      // Note: set-cookie is typically a response header, but the implementation
      // handles it generically for proxy/middleware scenarios where requests
      // might forward response headers. This tests the array-handling logic.
      headerEntries = [
        ['set-cookie', 'session=abc123; Path=/'],
        ['set-cookie', 'user=vikram; Path=/'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.headers['set-cookie']).toEqual(['session=abc123; Path=/', 'user=vikram; Path=/']);
    });

    it('should discard duplicate content-length headers', () => {
      headerEntries = [
        ['content-length', '100'],
        ['content-length', '200'],
      ];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.headers['content-length']).toBe('100');
    });

    it('should provide get() method for header access', () => {
      headerEntries = [['content-type', 'application/json']];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.get('content-type')).toBe('application/json');
      expect(req.get('Content-Type')).toBe('application/json');
    });

    it('should provide header() alias', () => {
      headerEntries = [['authorization', 'Bearer token']];

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.header('authorization')).toBe('Bearer token');
    });
  });

  describe('query parameters', () => {
    it('should parse query parameters lazily', () => {
      mockUwsReq.getQuery.mockReturnValue('page=1&limit=10');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.queryParams).toEqual({
        page: '1',
        limit: '10',
      });
    });

    it('should handle values containing equals sign', () => {
      mockUwsReq.getQuery.mockReturnValue('key=val=ue');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.queryParams).toEqual({
        key: 'val=ue',
      });
    });

    it('should handle malformed URI encoding', () => {
      mockUwsReq.getQuery.mockReturnValue('key=%ZZ');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.queryParams).toEqual({
        key: '%ZZ',
      });
    });

    it('should handle array parameters', () => {
      mockUwsReq.getQuery.mockReturnValue('tag=js&tag=ts&tag=node');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.queryParams).toEqual({
        tag: ['js', 'ts', 'node'],
      });
    });

    it('should handle empty values', () => {
      mockUwsReq.getQuery.mockReturnValue('key1=&key2');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.queryParams).toEqual({
        key1: '',
        key2: '',
      });
    });
  });

  describe('content helpers', () => {
    it('should return content-type', () => {
      setHeaders(['content-type', 'application/json; charset=utf-8']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.contentType).toBe('application/json; charset=utf-8');
    });

    describe('contentLength', () => {
      it('should return valid content-length as number', () => {
        setHeaders(['content-length', '1024']);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);

        expect(req.contentLength).toBe(1024);
      });

      it('should handle whitespace in content-length', () => {
        setHeaders(['content-length', '  1024  ']);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);

        expect(req.contentLength).toBe(1024);
      });

      it.each([
        ['invalid', 'non-numeric'],
        ['-100', 'negative'],
        ['10abc', 'partially numeric'],
        ['10.5', 'decimal'],
        ['1e3', 'scientific notation'],
        ['9007199254740992', 'unsafe integer (MAX_SAFE_INTEGER + 1)'],
      ])('should return undefined for %s content-length (%s)', (value) => {
        setHeaders(['content-length', value]);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);

        expect(req.contentLength).toBeUndefined();
      });
    });

    describe('is()', () => {
      it('should check content type', () => {
        setHeaders(['content-type', 'application/json']);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);

        expect(req.is('json')).toBe(true);
        expect(req.is('application/json')).toBe(true);
        expect(req.is('text/html')).toBe(false);
      });

      it.each([
        ['application/vnd.api+json', 'json', 'xml'],
        ['application/ld+json', 'json', 'xml'],
        ['application/atom+xml', 'xml', 'json'],
      ])('should handle structured syntax suffixes: %s', (contentType, matchType, nonMatchType) => {
        setHeaders(['content-type', contentType]);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);

        expect(req.is(matchType)).toBe(true);
        expect(req.is(contentType)).toBe(true);
        expect(req.is(nonMatchType)).toBe(false);
      });
    });
  });

  describe('body parsing', () => {
    it('should return empty buffer when no body parser initialized', async () => {
      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      const buffer = await req.buffer();

      expect(buffer.length).toBe(0);
    });

    it('should initialize body parser', () => {
      setHeaders(['content-length', '10']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      expect(mockUwsRes.onData).toHaveBeenCalled();
    });

    it('should initialize body parser for chunked transfer encoding', () => {
      setHeaders(['transfer-encoding', 'chunked']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      expect(mockUwsRes.onData).toHaveBeenCalled();
      expect(req.isReceived).toBe(false); // Should expect body
    });

    it('should not initialize body parser when no content-length or transfer-encoding', () => {
      // No headers set - no body expected
      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      expect(mockUwsRes.onData).not.toHaveBeenCalled();
      expect(req.isReceived).toBe(true); // No body expected
    });

    it('should parse JSON body', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', '{"name":"Vikram"}');

      const jsonPromise = req.json();
      sendBody(bodyContent);

      const result = await jsonPromise;

      expect(result).toEqual({ name: 'Vikram' });
    });

    it('should throw error for invalid JSON', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', 'not valid json');

      const jsonPromise = req.json();
      sendBody(bodyContent);

      await expect(jsonPromise).rejects.toThrow('Invalid JSON');
    });

    it('should parse text body', async () => {
      const { req, bodyContent } = createRequestWithBody('text/plain', 'Hello World');

      const textPromise = req.text();
      sendBody(bodyContent);

      const result = await textPromise;

      expect(result).toBe('Hello World');
    });

    it('should parse URL-encoded body', async () => {
      const { req, bodyContent } = createRequestWithBody(
        'application/x-www-form-urlencoded',
        'name=Vikram&age=30'
      );

      const urlencodedPromise = req.urlencoded();
      sendBody(bodyContent);

      const result = await urlencodedPromise;

      expect(result).toEqual({
        name: 'Vikram',
        age: '30',
      });
    });

    describe('caching', () => {
      it('should cache parsed JSON', async () => {
        await testBodyParsingWithCache(
          'application/json',
          '{"name":"Vikram"}',
          (req) => req.json(),
          { name: 'Vikram' }
        );
      });

      it('should cache parsed text', async () => {
        await testBodyParsingWithCache('text/plain', 'Hello', (req) => req.text(), 'Hello');
      });

      it('should cache parsed URL-encoded body', async () => {
        await testBodyParsingWithCache(
          'application/x-www-form-urlencoded',
          'key=value',
          (req) => req.urlencoded(),
          { key: 'value' }
        );
      });

      it('should cache raw buffer', async () => {
        setHeaders(['content-length', '5']);

        const req = new UwsRequest(mockUwsReq, mockUwsRes);
        req._initBodyParser(1024 * 1024);

        const bufferPromise = req.buffer();
        sendBody('Hello');

        const result1 = await bufferPromise;
        const result2 = await req.buffer();

        expect(result1).toBe(result2);
      });
    });

    it('should auto-parse JSON body via body getter', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', '{"name":"Vikram"}');

      const bodyPromise = req.body;
      sendBody(bodyContent);

      const result = (await bodyPromise) as { name: string };

      expect(result).toEqual({ name: 'Vikram' });
    });

    it('should auto-parse URL-encoded body via body getter', async () => {
      const { req, bodyContent } = createRequestWithBody(
        'application/x-www-form-urlencoded',
        'key=value'
      );

      const bodyPromise = req.body;
      sendBody(bodyContent);

      const result = (await bodyPromise) as Record<string, string>;

      expect(result).toEqual({ key: 'value' });
    });

    it('should auto-parse text body via body getter', async () => {
      const { req, bodyContent } = createRequestWithBody('text/plain', 'Hello');

      const bodyPromise = req.body;
      sendBody(bodyContent);

      const result = (await bodyPromise) as string;

      expect(result).toBe('Hello');
    });

    it('should return buffer for unknown content-type via body getter', async () => {
      const { req, bodyContent } = createRequestWithBody('application/octet-stream', 'Hello');

      const bodyPromise = req.body;
      sendBody(bodyContent);

      const result = (await bodyPromise) as Buffer;

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('Hello');
    });

    it('should handle chunked body data', async () => {
      setHeaders(['content-type', 'text/plain'], ['content-length', '11']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      const textPromise = req.text();

      // Send in multiple chunks (simulating real network behavior)
      onDataCallback(toArrayBuffer(Buffer.from('Hello ')), false);
      onDataCallback(toArrayBuffer(Buffer.from('World')), true);

      const result = await textPromise;

      expect(result).toBe('Hello World');
    });

    it('should enforce size limit and close connection', async () => {
      // Set content-length larger than limit
      setHeaders(['content-length', '2000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1000); // 1KB limit

      // Connection should be closed immediately
      expect(mockUwsRes.close).toHaveBeenCalled();

      // Request should be marked as aborted
      expect(req.isAborted).toBe(true);

      // Body promises should reject with error
      await expect(req.buffer()).rejects.toThrow('Body size limit exceeded');
    });

    it('should enforce size limit during streaming when accumulated data exceeds limit', async () => {
      // Use chunked encoding (no Content-Length) to test streaming limit
      setHeaders(['transfer-encoding', 'chunked']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(50); // 50 byte limit

      // Start consuming the body
      const bufferPromise = req.buffer();

      // Send chunk that exceeds limit during streaming
      const largeChunk = Buffer.alloc(100, 'x');
      onDataCallback(toArrayBuffer(largeChunk), true);

      // Should close connection when limit exceeded during streaming
      expect(mockUwsRes.close).toHaveBeenCalled();

      // Should reject with size limit error
      await expect(bufferPromise).rejects.toThrow('Body size limit exceeded');
    });
  });

  describe('abort handling', () => {
    let onAbortedCallback: () => void = () => {
      throw new Error('onAbortedCallback not yet initialized');
    };

    beforeEach(() => {
      mockUwsRes.onAborted = jest.fn((callback) => {
        onAbortedCallback = callback;
        return mockUwsRes;
      });
    });

    it('should detect aborted connection', () => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      // Add error listener to prevent unhandled error
      req.on('error', () => {
        // Expected error
      });

      expect(req.isAborted).toBe(false);

      // Simulate connection abort
      onAbortedCallback();

      expect(req.isAborted).toBe(true);
    });

    it.each([
      ['buffer()', 'application/json', '{"test":"data"}', (req: UwsRequest) => req.buffer()],
      ['json()', 'application/json', '{"test":"data"}', (req: UwsRequest) => req.json()],
      ['text()', 'text/plain', 'Hello World', (req: UwsRequest) => req.text()],
      [
        'urlencoded()',
        'application/x-www-form-urlencoded',
        'key=value',
        (req: UwsRequest) => req.urlencoded(),
      ],
    ] as const)(
      'should reject %s promise when connection is aborted',
      async (methodName, contentType, bodyContent, method) => {
        const { req } = createRequestWithBody(contentType, bodyContent);

        const promise = method(req);

        // Simulate connection abort
        onAbortedCallback();

        await expect(promise).rejects.toThrow('Connection aborted');
      }
    );

    it('should stop processing chunks after abort', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', '{"test":"data"}');

      const bufferPromise = req.buffer();

      // Simulate connection abort
      onAbortedCallback();

      // Try to send data after abort - should be ignored
      sendBody(bodyContent);

      // Promise should still reject with abort error
      await expect(bufferPromise).rejects.toThrow('Connection aborted');
    });

    it('should emit error event on abort', (done) => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      req.on('error', (error) => {
        expect(error.message).toBe('Connection aborted');
        done();
      });

      // Simulate connection abort
      onAbortedCallback();
    });

    it('should handle abort during streaming mode', (done) => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      // Activate streaming mode
      req.pipe(
        new Writable({
          write(chunk: Buffer, encoding: string, callback: () => void) {
            callback();
          },
        })
      );

      req.on('error', (error) => {
        expect(error.message).toBe('Connection aborted');
        done();
      });

      // Simulate connection abort
      onAbortedCallback();
    });

    it('should throw error when getAllData is called after abort', async () => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      // Add error listener to prevent unhandled error
      req.on('error', () => {
        // Expected error
      });

      // Simulate connection abort
      onAbortedCallback();

      // Try to get data after abort
      await expect(req.buffer()).rejects.toThrow('Connection aborted');
    });

    it('should not emit error when no error listeners attached', () => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      // Don't add error listener - this should not cause uncaught error
      expect(req.isAborted).toBe(false);

      // Simulate connection abort - should not throw
      expect(() => onAbortedCallback()).not.toThrow();

      expect(req.isAborted).toBe(true);
    });
  });

  describe('watermark backpressure', () => {
    it('should pause when buffered data exceeds watermark in awaiting mode', () => {
      setHeaders(['content-type', 'application/json'], ['content-length', '200000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send large chunk that exceeds 128KB watermark
      const largeChunk = Buffer.alloc(150 * 1024, 'x');
      onDataCallback(toArrayBuffer(largeChunk), false);

      // Should have paused due to watermark
      expect(mockUwsRes.pause).toHaveBeenCalled();
    });

    it('should resume when switching from awaiting to buffering mode', async () => {
      setHeaders(['content-type', 'application/json'], ['content-length', '200000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send large chunk that exceeds watermark
      const largeChunk = Buffer.alloc(150 * 1024, 'x');
      onDataCallback(toArrayBuffer(largeChunk), false);

      expect(mockUwsRes.pause).toHaveBeenCalled();

      // Start consuming body - should resume
      const bufferPromise = req.buffer();

      // Send remaining data
      onDataCallback(toArrayBuffer(Buffer.from('}')), true);

      await bufferPromise;

      // Should have resumed
      expect(mockUwsRes.resume).toHaveBeenCalled();
    });

    it('should not pause in buffering mode even with large chunks', () => {
      setHeaders(['content-type', 'application/json'], ['content-length', '200000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Start buffering immediately
      void req.buffer();

      // Send large chunk - should not pause in buffering mode
      const largeChunk = Buffer.alloc(150 * 1024, 'x');
      onDataCallback(toArrayBuffer(largeChunk), true);

      // Should not have paused
      expect(mockUwsRes.pause).not.toHaveBeenCalled();
    });

    it('should pause in streaming mode when push returns false', () => {
      setHeaders(['content-type', 'application/octet-stream'], ['content-length', '1000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Mock push to return false (backpressure)
      jest.spyOn(req, 'push').mockReturnValue(false);

      // Activate streaming mode
      const writable = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          callback();
        },
      });
      req.pipe(writable);

      // Send data - should pause due to backpressure
      onDataCallback(toArrayBuffer(Buffer.from('test data')), false);

      expect(mockUwsRes.pause).toHaveBeenCalled();
    });

    it('should resume in streaming mode when _read is called', () => {
      setHeaders(['content-type', 'application/octet-stream'], ['content-length', '1000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Mock push to return false (backpressure)
      jest.spyOn(req, 'push').mockReturnValue(false);

      // Activate streaming mode
      const writable = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          callback();
        },
      });
      req.pipe(writable);

      // Send data - should pause
      onDataCallback(toArrayBuffer(Buffer.from('test data')), false);

      expect(mockUwsRes.pause).toHaveBeenCalled();

      // Call _read (consumer ready for more data)
      req._read();

      // Should have resumed
      expect(mockUwsRes.resume).toHaveBeenCalled();
    });

    it('should resume when activating streaming mode after watermark pause', () => {
      setHeaders(['content-type', 'application/octet-stream'], ['content-length', '200000']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send large chunk that exceeds watermark in awaiting mode
      const largeChunk = Buffer.alloc(150 * 1024, 'x');
      onDataCallback(toArrayBuffer(largeChunk), false);

      expect(mockUwsRes.pause).toHaveBeenCalled();

      // Activate streaming mode - should resume
      const writable = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          callback();
        },
      });
      req.pipe(writable);

      expect(mockUwsRes.resume).toHaveBeenCalled();
    });
  });

  describe('streaming state', () => {
    it('should report isReceived as false initially when body expected', () => {
      setHeaders(['content-length', '100']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      expect(req.isReceived).toBe(false);
    });

    it('should report isReceived as true when no body expected', () => {
      setHeaders(['content-length', '0']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      expect(req.isReceived).toBe(true);
    });

    it('should report isReceived as true after all data received', () => {
      const { req, bodyContent } = createRequestWithBody('text/plain', 'Hello');

      expect(req.isReceived).toBe(false);

      sendBody(bodyContent);

      expect(req.isReceived).toBe(true);
    });

    it('should track total received bytes', () => {
      const { req } = createRequestWithBody('text/plain', 'Hello World');

      expect(req.getTotalReceivedBytes()).toBe(0);

      onDataCallback(toArrayBuffer(Buffer.from('Hello ')), false);
      expect(req.getTotalReceivedBytes()).toBe(6);

      onDataCallback(toArrayBuffer(Buffer.from('World')), true);
      expect(req.getTotalReceivedBytes()).toBe(11);
    });

    it('should emit received event with total bytes', (done) => {
      const { req, bodyContent } = createRequestWithBody('text/plain', 'Hello');

      req.on('received', (totalBytes) => {
        expect(totalBytes).toBe(5);
        done();
      });

      sendBody(bodyContent);
    });
  });

  describe('Hybrid Readable Stream', () => {
    it('should buffer chunks in awaiting mode by default', () => {
      setHeaders(['content-type', 'application/json'], ['content-length', '100']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send some data
      onDataCallback(toArrayBuffer(Buffer.from('{"test":')), false);
      onDataCallback(toArrayBuffer(Buffer.from('"data"}')), false);

      // Should be buffering in awaiting mode
      expect(req.getTotalReceivedBytes()).toBe(15);
      expect(req.isReceived).toBe(false);
    });

    it('should switch to buffering mode for json()', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', '{"name":"test"}');

      // Start json parsing - should switch to buffering mode
      const jsonPromise = req.json();

      // Send data
      sendBody(bodyContent);

      const result = await jsonPromise;
      expect(result).toEqual({ name: 'test' });
    });

    it('should switch to streaming mode for pipe()', (done) => {
      const { req } = createRequestWithBody('application/octet-stream', 'Hello World');

      const chunks: Buffer[] = [];
      const writable = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          chunks.push(chunk);
          callback();
        },
      });

      writable.on('finish', () => {
        const result = Buffer.concat(chunks).toString();
        expect(result).toBe('Hello World');
        done();
      });

      // Pipe should activate streaming mode
      req.pipe(writable);

      // Send data
      sendBody('Hello World');
    });

    it('should flush buffered chunks when activating streaming', (done) => {
      setHeaders(['content-type', 'application/octet-stream'], ['content-length', '100']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send data while in awaiting mode (will be buffered)
      onDataCallback(toArrayBuffer(Buffer.from('Hello ')), false);
      onDataCallback(toArrayBuffer(Buffer.from('World')), false);

      // Now activate streaming mode by piping
      const chunks: Buffer[] = [];
      const writable = new Writable({
        write(chunk: Buffer, encoding: string, callback: () => void) {
          chunks.push(chunk);
          callback();
        },
      });

      writable.on('finish', () => {
        const result = Buffer.concat(chunks).toString();
        expect(result).toBe('Hello World');
        done();
      });

      req.pipe(writable);

      // Send final chunk
      onDataCallback(toArrayBuffer(Buffer.from('')), true);
    });

    it('should activate streaming mode for non-pipe consumers', (done) => {
      jest.useFakeTimers();

      setHeaders(['content-type', 'application/octet-stream'], ['content-length', '100']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Send some data while in awaiting mode
      onDataCallback(toArrayBuffer(Buffer.from('Hello ')), false);

      // Use for-await-of (non-pipe consumer) which calls _read()
      const chunks: Buffer[] = [];
      (async () => {
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const result = Buffer.concat(chunks).toString();
        expect(result).toBe('Hello World');
        done();
      })();

      // Send more data after streaming is activated
      // Use setImmediate for deterministic timing
      setImmediate(() => {
        onDataCallback(toArrayBuffer(Buffer.from('World')), true);
      });

      // Advance timers to trigger setImmediate
      jest.runAllTimers();
      jest.useRealTimers();
    });

    it('should support multipart streaming', async () => {
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      let body = `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="field"\r\n\r\n`;
      body += `value\r\n`;
      body += `--${boundary}--\r\n`;

      setHeaders(
        ['content-type', `multipart/form-data; boundary=${boundary}`],
        ['content-length', body.length.toString()]
      );

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      const fields: MultipartField[] = [];
      const parsePromise = req.multipart(async (field) => {
        fields.push(field);
      });

      sendBody(body);
      await parsePromise;

      expect(fields).toHaveLength(1);
      expect(fields[0].name).toBe('field');
      expect(fields[0].value).toBe('value');
    });

    it('should throw error when multipart called after body consumed', async () => {
      const { req, bodyContent } = createRequestWithBody('multipart/form-data', 'test');

      // Consume the body first
      sendBody(bodyContent);
      await req.buffer();

      // Try to parse multipart - should throw
      await expect(req.multipart(async () => {})).rejects.toThrow(
        'Cannot parse multipart: request body already consumed'
      );
    });

    it('should throw error when content-type is not multipart', async () => {
      const { req } = createRequestWithBody('application/json', '{"test":"data"}');

      // Try to parse multipart with wrong content-type - should throw
      await expect(req.multipart(async () => {})).rejects.toThrow(
        'Cannot parse multipart: Content-Type must be multipart/*, got: application/json'
      );
    });

    it('should throw error when no content-type header', async () => {
      setHeaders(['content-length', '10']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._initBodyParser(1024 * 1024);

      // Try to parse multipart without content-type - should throw
      await expect(req.multipart(async () => {})).rejects.toThrow(
        'Cannot parse multipart: Content-Type must be multipart/*, got: none'
      );
    });

    it('should emit received event with total bytes in hybrid mode', (done) => {
      const { req, bodyContent } = createRequestWithBody('text/plain', 'Hello World');

      req.on('received', (totalBytes) => {
        expect(totalBytes).toBe(11);
        expect(req.getTotalReceivedBytes()).toBe(11);
        done();
      });

      sendBody(bodyContent);
    });

    it('should work with NestJS pipes and transformations', async () => {
      const { req, bodyContent } = createRequestWithBody('application/json', '{"name":"test"}');

      // Send and parse the actual body first
      const bodyPromise = req.body;
      sendBody(bodyContent);
      const originalBody = await bodyPromise;

      // Verify original body was parsed correctly
      expect(originalBody).toEqual({ name: 'test' });

      // Simulate NestJS pipe transformation
      const transformedData = { name: 'TRANSFORMED' };
      req._setTransformedBody(transformedData);

      // Body getter should now return transformed data (overriding parsed body)
      const body = await req.body;
      expect(body).toEqual(transformedData);
      expect(body).not.toEqual({ name: 'test' });
    });
  });

  describe('cookies', () => {
    it('should parse cookies from Cookie header', () => {
      setHeaders(['cookie', 'session=abc123; user=vikram; theme=dark']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.cookies).toEqual({
        session: 'abc123',
        user: 'vikram',
        theme: 'dark',
      });
    });

    it('should return empty object when no Cookie header', () => {
      setHeaders(['content-type', 'application/json']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.cookies).toEqual({});
    });

    it('should cache parsed cookies', () => {
      setHeaders(['cookie', 'session=abc123']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      const cookies1 = req.cookies;
      const cookies2 = req.cookies;

      expect(cookies1).toBe(cookies2); // Same object reference
    });

    it('should handle empty cookie value', () => {
      setHeaders(['cookie', 'empty=; session=abc123']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.cookies).toEqual({
        empty: '',
        session: 'abc123',
      });
    });

    it('should handle URL-encoded cookie values', () => {
      setHeaders(['cookie', 'name=Vikram%20Aditya; email=vikram%40example.com']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.cookies).toEqual({
        name: 'Vikram Aditya',
        email: 'vikram@example.com',
      });
    });
  });

  describe('signedCookies', () => {
    const SECRET = 'my-secret';

    const setupSignedCookie = (name: string, value: string, secret = SECRET) => {
      const signedValue = createSignedCookie(value, secret);
      setHeaders(['cookie', `${name}=${signedValue}; user=vikram`]);
    };

    it('should parse and verify signed cookies with method API', () => {
      setupSignedCookie('session', 'abc123');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      const signedCookies = req.getSignedCookies(SECRET);

      expect(signedCookies).toEqual({ session: 'abc123' });
    });

    it('should parse and verify signed cookies with property API', () => {
      setupSignedCookie('session', 'abc123');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      req._setCookieSecret(SECRET);

      expect(req.signedCookies).toEqual({ session: 'abc123' });
    });

    it('should ignore unsigned cookies', () => {
      setHeaders(['cookie', 'session=abc123; user=vikram']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      const signedCookies = req.getSignedCookies(SECRET);

      expect(signedCookies).toEqual({});
    });

    it('should reject cookies with invalid signatures', () => {
      setHeaders(['cookie', 'session=s:abc123.invalidsignature']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      const signedCookies = req.getSignedCookies(SECRET);

      expect(signedCookies).toEqual({});
    });

    it('should return new object on each call (no caching)', () => {
      setupSignedCookie('session', 'abc123', SECRET);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      const signedCookies1 = req.getSignedCookies(SECRET);
      const signedCookies2 = req.getSignedCookies(SECRET);

      expect(signedCookies1).not.toBe(signedCookies2);
      expect(signedCookies1).toEqual(signedCookies2);
    });

    it('should handle different secrets correctly', () => {
      const signedWithSecret1 = createSignedCookie('value1', 'secret1');
      const signedWithSecret2 = createSignedCookie('value2', 'secret2');

      setHeaders(['cookie', `cookie1=${signedWithSecret1}; cookie2=${signedWithSecret2}`]);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.getSignedCookies('secret1')).toEqual({ cookie1: 'value1' });
      expect(req.getSignedCookies('secret2')).toEqual({ cookie2: 'value2' });
    });

    it('should not use cached result when secret changes', () => {
      setupSignedCookie('session', 'abc123', 'secret-1');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.getSignedCookies('secret-1')).toEqual({ session: 'abc123' });
      expect(req.getSignedCookies('secret-2')).toEqual({});
      expect(req.getSignedCookies('secret-1')).toEqual({ session: 'abc123' });
    });

    it('should return empty object from property when no secret set', () => {
      setupSignedCookie('session', 'abc123');

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.signedCookies).toEqual({});
    });

    it('should return empty object when no signed cookies', () => {
      setHeaders(['cookie', 'session=abc123']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.getSignedCookies(SECRET)).toEqual({});
    });
  });
});
