import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { UwsRequest } from './uws-request';
import { toArrayBuffer } from './test-helpers';
import * as signature from 'cookie-signature';

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

    const setupSignedCookie = (name: string, value: string, secret: string) => {
      const signedValue = createSignedCookie(value, secret);
      setHeaders(['cookie', `${name}=${signedValue}; user=vikram`]);
    };

    it('should parse and verify signed cookies with method API', () => {
      setupSignedCookie('session', 'abc123', SECRET);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);
      const signedCookies = req.getSignedCookies(SECRET);

      expect(signedCookies).toEqual({ session: 'abc123' });
    });

    it('should parse and verify signed cookies with property API', () => {
      setupSignedCookie('session', 'abc123', SECRET);

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

    it('should return empty object when no signed cookies', () => {
      setHeaders(['cookie', 'session=abc123']);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.getSignedCookies(SECRET)).toEqual({});
    });

    it('should return empty object from property when no secret set', () => {
      setupSignedCookie('session', 'abc123', SECRET);

      const req = new UwsRequest(mockUwsReq, mockUwsRes);

      expect(req.signedCookies).toEqual({});
    });
  });
});
