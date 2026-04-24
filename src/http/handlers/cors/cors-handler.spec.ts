import { CorsHandler } from './cors-handler';
import { UwsRequest } from '../../core/request';
import { UwsResponse } from '../../core/response';

describe('CorsHandler', () => {
  let mockReq: Partial<UwsRequest>;
  let mockRes: Partial<UwsResponse>;
  let setHeaderSpy: jest.Mock;
  let statusSpy: jest.Mock;
  let sendSpy: jest.Mock;

  // Helper to setup request with origin and method
  const setupRequest = (origin?: string, method = 'GET') => {
    const headers: Record<string, string> = {};
    if (origin !== undefined) {
      headers.origin = origin;
    }

    mockReq = {
      method,
      headers,
    };
  };

  // Helper to handle CORS and return result
  const handleCors = async (handler: CorsHandler) => {
    return await handler.handle(mockReq as UwsRequest, mockRes as UwsResponse);
  };

  // Helper to verify header was set
  const expectHeader = (name: string, value: string) => {
    expect(setHeaderSpy).toHaveBeenCalledWith(name, value);
  };

  // Helper to verify header was not set
  const expectNoHeader = (name: string) => {
    expect(setHeaderSpy).not.toHaveBeenCalledWith(name, expect.anything());
  };

  beforeEach(() => {
    setHeaderSpy = jest.fn();
    statusSpy = jest.fn().mockReturnThis();
    sendSpy = jest.fn();

    mockReq = {
      method: 'GET',
      headers: {},
    };

    mockRes = {
      setHeader: setHeaderSpy,
      status: statusSpy,
      send: sendSpy,
      getHeader: jest.fn().mockReturnValue(undefined), // Default: no existing headers
    };
  });

  describe('Default Configuration', () => {
    it('should allow all origins by default', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com');

      const handled = await handleCors(handler);

      expect(handled).toBe(false);
      expectHeader('access-control-allow-origin', '*');
    });

    it('should use default methods', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');

      await handleCors(handler);

      expectHeader('access-control-allow-methods', 'GET, HEAD, PUT, PATCH, POST, DELETE');
    });

    it('should use default allowed headers', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');

      await handleCors(handler);

      expectHeader('access-control-allow-headers', 'Content-Type, Authorization');
    });

    it('should use default maxAge (24 hours)', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');

      await handleCors(handler);

      expectHeader('access-control-max-age', '86400');
    });

    it('should not set credentials header by default', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com');

      await handleCors(handler);

      expectNoHeader('access-control-allow-credentials');
    });

    it('should not set exposed headers by default', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com');

      await handleCors(handler);

      expectNoHeader('access-control-expose-headers');
    });
  });

  describe('Origin Validation', () => {
    it('should allow specific origin (string)', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      setupRequest('https://example.com');

      const handled = await handleCors(handler);

      expect(handled).toBe(false);
      expectHeader('access-control-allow-origin', 'https://example.com');
    });

    it('should reject non-matching origin (string)', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      setupRequest('https://evil.com');

      const handled = await handleCors(handler);

      expect(handled).toBe(false);
      expect(setHeaderSpy).not.toHaveBeenCalled();
    });

    it('should allow wildcard origin (*)', async () => {
      const handler = new CorsHandler({ origin: '*' });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-origin', '*');
    });

    it('should allow multiple origins (array)', async () => {
      const handler = new CorsHandler({
        origin: ['https://example.com', 'https://app.example.com'],
      });
      setupRequest('https://app.example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-origin', 'https://app.example.com');
    });

    it('should reject origin not in array', async () => {
      const handler = new CorsHandler({
        origin: ['https://example.com', 'https://app.example.com'],
      });
      setupRequest('https://evil.com');

      await handleCors(handler);

      expect(setHeaderSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['boolean true', true, '*'],
      ['boolean false', false, null],
    ])('should handle origin as %s', async (_desc, originValue, expectedHeader) => {
      const handler = new CorsHandler({ origin: originValue as boolean });
      setupRequest('https://example.com');

      await handleCors(handler);

      if (expectedHeader) {
        expectHeader('access-control-allow-origin', expectedHeader);
      } else {
        expect(setHeaderSpy).not.toHaveBeenCalled();
      }
    });

    it.each([
      [
        'accept',
        (origin: string | null) => origin?.endsWith('.example.com') ?? false,
        'https://app.example.com',
        true,
      ],
      [
        'reject',
        (origin: string | null) => origin?.endsWith('.example.com') ?? false,
        'https://evil.com',
        false,
      ],
    ])(
      'should %s origin with dynamic validation',
      async (_desc, originFn, requestOrigin, shouldAllow) => {
        const handler = new CorsHandler({ origin: originFn });
        setupRequest(requestOrigin);

        await handleCors(handler);

        if (shouldAllow) {
          expectHeader('access-control-allow-origin', requestOrigin);
        } else {
          expect(setHeaderSpy).not.toHaveBeenCalled();
        }
      }
    );

    it('should handle missing origin header', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      setupRequest();

      await handleCors(handler);

      // Should allow requests without origin (same-origin or privacy-sensitive)
      expectHeader('access-control-allow-origin', 'https://example.com');
    });

    it('should handle array origin header (take first value)', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      mockReq = {
        method: 'GET',
        headers: { origin: ['https://example.com', 'https://other.com'] as any },
      };

      await handleCors(handler);

      expectHeader('access-control-allow-origin', 'https://example.com');
    });
  });

  describe('Credentials', () => {
    it('should set credentials header when enabled', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-credentials', 'true');
    });

    it('should echo origin when credentials enabled', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-origin', 'https://example.com');
      expectHeader('vary', 'Origin');
    });

    it('should not use wildcard with credentials', async () => {
      const handler = new CorsHandler({ origin: true, credentials: true });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-origin', 'https://example.com');
    });

    it('should not set ACAO when credentials enabled but no origin header', async () => {
      const handler = new CorsHandler({ origin: true, credentials: true });
      setupRequest(undefined); // No origin header

      await handleCors(handler);

      // Should not set ACAO at all to avoid wildcard+credentials violation
      expect(setHeaderSpy).not.toHaveBeenCalledWith(
        'access-control-allow-origin',
        expect.anything()
      );
      expectHeader('access-control-allow-credentials', 'true');
    });
  });

  describe('Exposed Headers', () => {
    it.each([
      ['array', ['X-Custom-Header', 'X-Another-Header'], 'X-Custom-Header, X-Another-Header'],
      ['string', 'X-Custom-Header', 'X-Custom-Header'],
    ])('should handle exposed headers as %s', async (_desc, exposedHeaders, expected) => {
      const handler = new CorsHandler({ exposedHeaders });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-expose-headers', expected);
    });

    it('should not set exposed headers when empty', async () => {
      const handler = new CorsHandler({ exposedHeaders: [] });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectNoHeader('access-control-expose-headers');
    });
  });

  describe('Preflight Requests (OPTIONS)', () => {
    it('should handle preflight request', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(statusSpy).toHaveBeenCalledWith(204);
      expect(sendSpy).toHaveBeenCalled();
    });

    it.each([
      ['array', ['GET', 'POST', 'PUT'], 'GET, POST, PUT'],
      ['string', 'GET', 'GET'],
    ])('should handle methods as %s', async (_desc, methods, expected) => {
      const handler = new CorsHandler({ methods });
      setupRequest('https://example.com', 'OPTIONS');

      await handleCors(handler);

      expectHeader('access-control-allow-methods', expected);
    });

    it('should use requested headers if provided', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-headers'] = 'X-Custom-Header, X-Another';

      await handleCors(handler);

      expectHeader('access-control-allow-headers', 'X-Custom-Header, X-Another');
    });

    it('should handle array requested headers (take first)', async () => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-headers'] = ['X-Custom-Header', 'X-Another'] as any;

      await handleCors(handler);

      expectHeader('access-control-allow-headers', 'X-Custom-Header');
    });

    it.each([
      ['array', ['X-Custom', 'X-Another'], 'X-Custom, X-Another'],
      ['string', 'X-Custom', 'X-Custom'],
    ])(
      'should use configured headers as %s when no requested headers',
      async (_desc, allowedHeaders, expected) => {
        const handler = new CorsHandler({ allowedHeaders });
        setupRequest('https://example.com', 'OPTIONS');

        await handleCors(handler);

        expectHeader('access-control-allow-headers', expected);
      }
    );

    it('should set maxAge in preflight', async () => {
      const handler = new CorsHandler({ maxAge: 3600 });
      setupRequest('https://example.com', 'OPTIONS');

      await handleCors(handler);

      expectHeader('access-control-max-age', '3600');
    });

    it('should reject preflight for disallowed origin with 403', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      setupRequest('https://evil.com', 'OPTIONS');

      const handled = await handleCors(handler);

      expect(handled).toBe(true); // Preflight was handled
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should reject preflight with 403 when requested headers are not allowed', async () => {
      const handler = new CorsHandler({
        allowedHeaders: ['Content-Type', 'Authorization'],
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-headers'] = 'X-Custom-Header, X-Forbidden';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(statusSpy).toHaveBeenCalledWith(403);
      expectNoHeader('access-control-allow-headers');
    });

    it('should reject preflight with disallowed method', async () => {
      const handler = new CorsHandler({
        methods: ['GET', 'POST'],
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'DELETE';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(statusSpy).toHaveBeenCalledWith(403);
      expectNoHeader('access-control-allow-methods');
    });

    it('should allow preflight with allowed method', async () => {
      const handler = new CorsHandler({
        methods: ['GET', 'POST', 'DELETE'],
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'DELETE';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(statusSpy).toHaveBeenCalledWith(204);
      expectHeader('access-control-allow-methods', 'GET, POST, DELETE');
    });
  });

  describe('Simple Requests (Non-OPTIONS)', () => {
    it.each([['GET'], ['POST']])('should not handle simple %s request', async (method) => {
      const handler = new CorsHandler();
      setupRequest('https://example.com', method);

      const handled = await handleCors(handler);

      expect(handled).toBe(false);
    });

    it('should set CORS headers for simple requests', async () => {
      const handler = new CorsHandler({ origin: 'https://example.com' });
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('access-control-allow-origin', 'https://example.com');
    });
  });

  describe('Vary Header', () => {
    it.each([
      ['credentials', { credentials: true }],
      ['array origins', { origin: ['https://example.com', 'https://app.com'] }],
      ['function origin', { origin: (origin: string | null) => !!origin }],
    ])('should set Vary header with %s', async (_desc, options) => {
      const handler = new CorsHandler(options);
      setupRequest('https://example.com');

      await handleCors(handler);

      expectHeader('vary', 'Origin');
    });

    it.each([
      ['wildcard', { origin: true }],
      ['specific string origin', { origin: 'https://example.com' }],
    ])('should not set Vary header with %s', async (_desc, options) => {
      const handler = new CorsHandler(options);
      setupRequest('https://example.com');

      await handleCors(handler);

      expectNoHeader('vary');
    });

    it('should append to existing Vary header', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      // Simulate existing Vary header
      mockRes.getHeader = jest.fn().mockReturnValue('Accept-Encoding');

      await handleCors(handler);

      expectHeader('vary', 'Accept-Encoding, Origin');
    });

    it('should not duplicate Origin in Vary header', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      mockRes.getHeader = jest.fn().mockReturnValue('Origin, Accept-Encoding');

      await handleCors(handler);

      // Since Origin is already in Vary, setHeader for 'vary' should not be called at all
      expect(setHeaderSpy).not.toHaveBeenCalledWith('vary', expect.anything());
      // But other CORS headers should still be set
      expectHeader('access-control-allow-origin', 'https://example.com');
      expectHeader('access-control-allow-credentials', 'true');
    });

    it('should handle array Vary header values', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      // Simulate existing Vary header as array
      mockRes.getHeader = jest.fn().mockReturnValue(['Accept-Encoding', 'Accept-Language']);

      await handleCors(handler);

      expectHeader('vary', 'Accept-Encoding, Accept-Language, Origin');
    });

    it('should not match Origin as substring in other header names', async () => {
      const handler = new CorsHandler({ credentials: true });
      setupRequest('https://example.com');

      // Hypothetical custom header containing "origin" as substring
      mockRes.getHeader = jest.fn().mockReturnValue('X-Custom-Originator, Accept-Encoding');

      await handleCors(handler);

      // Should still add Origin since "X-Custom-Originator" is not "Origin"
      expectHeader('vary', 'X-Custom-Originator, Accept-Encoding, Origin');
    });
  });

  describe('Origin Validation Edge Cases', () => {
    describe('Empty and Null Origins', () => {
      it('should handle empty string origin (treated as no origin)', async () => {
        const handler = new CorsHandler({ origin: 'https://example.com' });
        setupRequest('');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'https://example.com');
      });

      it('should handle empty string in allowed origins array', async () => {
        const handler = new CorsHandler({ origin: ['https://example.com', ''] });
        setupRequest('');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', '*');
      });

      it('should handle null origin with function validator', async () => {
        const handler = new CorsHandler({
          origin: (origin: string | null) => origin === null || origin === 'https://example.com',
        });
        setupRequest();

        await handleCors(handler);

        expectHeader('access-control-allow-origin', '*');
      });

      it('should allow request without origin header', async () => {
        const handler = new CorsHandler({ origin: 'https://example.com' });
        setupRequest();

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'https://example.com');
      });
    });

    describe('Case Sensitivity', () => {
      it.each([
        ['uppercase scheme', 'HTTPS://example.com'],
        ['uppercase domain', 'https://EXAMPLE.COM'],
        ['mixed case', 'HtTpS://ExAmPlE.CoM'],
      ])('should be case-sensitive for origin matching (%s)', async (_desc, origin) => {
        const handler = new CorsHandler({ origin: 'https://example.com' });
        setupRequest(origin);

        await handleCors(handler);

        expect(setHeaderSpy).not.toHaveBeenCalled();
      });

      it('should match exact case in array', async () => {
        const handler = new CorsHandler({
          origin: ['https://example.com', 'HTTPS://EXAMPLE.COM'],
        });
        setupRequest('HTTPS://EXAMPLE.COM');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'HTTPS://EXAMPLE.COM');
      });

      it('should handle case-insensitive validation with function', async () => {
        const handler = new CorsHandler({
          origin: (origin: string | null) => origin?.toLowerCase() === 'https://example.com',
        });
        setupRequest('HTTPS://EXAMPLE.COM');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'HTTPS://EXAMPLE.COM');
      });
    });

    describe('Non-Matching Origins', () => {
      it.each([
        ['missing scheme', 'example.com'],
        ['invalid scheme', 'ftp://example.com'],
        ['trailing slash', 'https://example.com/'],
        ['with path', 'https://example.com/path'],
        ['with query', 'https://example.com?query=value'],
        ['with fragment', 'https://example.com#fragment'],
        ['different port', 'https://example.com:8080'],
        ['with credentials', 'https://user:pass@example.com'],
        ['double slashes', 'https:///example.com'],
        ['spaces', 'https://example .com'],
        ['special chars', 'https://example<>.com'],
      ])('should handle %s origin', async (_desc, origin) => {
        const handler = new CorsHandler({ origin: 'https://example.com' });
        setupRequest(origin);

        await handleCors(handler);

        expect(setHeaderSpy).not.toHaveBeenCalled();
      });

      it('should allow non-matching origin if explicitly in array', async () => {
        const handler = new CorsHandler({
          origin: ['https://example.com', 'example.com', 'https://example.com/'],
        });
        setupRequest('example.com');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'example.com');
      });

      it('should handle malformed origin with function validator', async () => {
        const handler = new CorsHandler({
          origin: (origin: string | null) => origin?.includes('example.com') ?? false,
        });
        setupRequest('example.com');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'example.com');
      });
    });

    describe('Whitespace Handling', () => {
      it.each([
        ['not trim', 'https://example.com', ' https://example.com ', false],
        ['match if explicitly allowed', ' https://example.com ', ' https://example.com ', true],
      ])(
        'should %s whitespace from origin',
        async (_desc, configOrigin, requestOrigin, shouldMatch) => {
          const handler = new CorsHandler({ origin: configOrigin });
          setupRequest(requestOrigin);

          await handleCors(handler);

          if (shouldMatch) {
            expectHeader('access-control-allow-origin', requestOrigin);
          } else {
            expect(setHeaderSpy).not.toHaveBeenCalled();
          }
        }
      );

      it('should handle whitespace in array origins', async () => {
        const handler = new CorsHandler({
          origin: ['https://example.com', ' https://example.com '],
        });
        setupRequest(' https://example.com ');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', ' https://example.com ');
      });
    });

    describe('Special Values', () => {
      it('should handle null origin (data: URLs, file: URLs)', async () => {
        const handler = new CorsHandler({ origin: 'null' });
        setupRequest('null');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'null');
      });

      it('should handle localhost origins', async () => {
        const handler = new CorsHandler({
          origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        });
        setupRequest('http://localhost:3000');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'http://localhost:3000');
      });

      it('should handle IPv6 origins', async () => {
        const handler = new CorsHandler({ origin: 'http://[::1]:3000' });
        setupRequest('http://[::1]:3000');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'http://[::1]:3000');
      });
    });

    describe('Function Validator Edge Cases', () => {
      it('should propagate errors from function validator', async () => {
        const handler = new CorsHandler({
          origin: () => {
            throw new Error('Validation error');
          },
        });
        setupRequest('https://example.com');

        await expect(async () => await handleCors(handler)).rejects.toThrow('Validation error');
      });

      it.each([
        ['true', 'https://example.com', true],
        ['false', 'https://evil.com', false],
      ])('should handle async function returning %s', async (_desc, origin, shouldAllow) => {
        const handler = new CorsHandler({
          origin: async (o: string | null) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return o === 'https://example.com';
          },
        });
        setupRequest(origin);

        await handleCors(handler);

        if (shouldAllow) {
          expectHeader('access-control-allow-origin', origin);
        } else {
          expect(setHeaderSpy).not.toHaveBeenCalled();
        }
      });

      it('should handle async function with null origin', async () => {
        const handler = new CorsHandler({
          origin: async (origin: string | null) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return origin === null || origin === 'https://example.com';
          },
        });
        setupRequest();

        await handleCors(handler);

        expectHeader('access-control-allow-origin', '*');
      });

      it('should propagate errors from async function validator', async () => {
        const handler = new CorsHandler({
          origin: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            throw new Error('Async validation error');
          },
        });
        setupRequest('https://example.com');

        await expect(async () => await handleCors(handler)).rejects.toThrow(
          'Async validation error'
        );
      });
    });

    describe('Array Edge Cases', () => {
      it('should handle empty array (reject all)', async () => {
        const handler = new CorsHandler({ origin: [] });
        setupRequest('https://example.com');

        await handleCors(handler);

        expect(setHeaderSpy).not.toHaveBeenCalled();
      });

      it('should handle array with duplicates', async () => {
        const handler = new CorsHandler({
          origin: ['https://example.com', 'https://example.com', 'https://example.com'],
        });
        setupRequest('https://example.com');

        await handleCors(handler);

        // Should match first occurrence
        expectHeader('access-control-allow-origin', 'https://example.com');
      });

      it('should handle array with mixed types', async () => {
        const handler = new CorsHandler({
          origin: ['https://example.com', '', 'null', 'http://localhost'] as any,
        });
        setupRequest('null');

        await handleCors(handler);

        expectHeader('access-control-allow-origin', 'null');
      });
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle full CORS configuration', async () => {
      const handler = new CorsHandler({
        origin: ['https://example.com', 'https://app.example.com'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Custom'],
        exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
        maxAge: 7200,
      });
      setupRequest('https://example.com', 'OPTIONS');

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expectHeader('access-control-allow-origin', 'https://example.com');
      expectHeader('access-control-allow-credentials', 'true');
      expectHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
      expectHeader('access-control-allow-headers', 'Content-Type, Authorization, X-Custom');
      expectHeader('access-control-expose-headers', 'X-Total-Count, X-Page-Number');
      expectHeader('access-control-max-age', '7200');
      expectHeader('vary', 'Origin');
    });

    it('should handle empty configuration', async () => {
      const handler = new CorsHandler({});
      setupRequest('https://example.com');

      const handled = await handleCors(handler);

      expect(handled).toBe(false);
      expectHeader('access-control-allow-origin', '*');
    });
  });

  describe('Preflight Header Validation', () => {
    it('should not set CORS headers on rejected preflight (disallowed method)', async () => {
      const handler = new CorsHandler({
        origin: 'https://example.com',
        methods: ['GET', 'POST'],
        credentials: true,
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'DELETE';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      // Should not have set any CORS headers before rejection
      expect(setHeaderSpy).not.toHaveBeenCalledWith(
        'access-control-allow-origin',
        expect.anything()
      );
      expect(setHeaderSpy).not.toHaveBeenCalledWith(
        'access-control-allow-credentials',
        expect.anything()
      );
    });

    it('should not set CORS headers on rejected preflight (disallowed headers)', async () => {
      const handler = new CorsHandler({
        origin: 'https://example.com',
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'POST';
      mockReq.headers!['access-control-request-headers'] = 'X-Custom-Header';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      // Should not have set any CORS headers before rejection
      expect(setHeaderSpy).not.toHaveBeenCalledWith(
        'access-control-allow-origin',
        expect.anything()
      );
      expect(setHeaderSpy).not.toHaveBeenCalledWith(
        'access-control-allow-credentials',
        expect.anything()
      );
    });

    it('should set CORS headers only after validation passes', async () => {
      const handler = new CorsHandler({
        origin: 'https://example.com',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true,
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'POST';
      mockReq.headers!['access-control-request-headers'] = 'Content-Type';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(mockRes.status).toHaveBeenCalledWith(204);
      // Should have set CORS headers after validation
      expectHeader('access-control-allow-origin', 'https://example.com');
      expectHeader('access-control-allow-credentials', 'true');
      expectHeader('access-control-allow-methods', 'GET, POST');
      expectHeader('access-control-allow-headers', 'content-type');
    });
  });

  describe('Empty allowedHeaders Array', () => {
    // Empty allowedHeaders array has dual behavior:
    // 1. When headers are requested: echo them back (permissive mode)
    // 2. When no headers are requested: use sensible defaults (Content-Type, Authorization)
    it('should treat empty allowedHeaders as permissive (echo mode)', async () => {
      const handler = new CorsHandler({
        origin: 'https://example.com',
        allowedHeaders: [],
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'POST';
      mockReq.headers!['access-control-request-headers'] = 'X-Custom-Header, X-Another-Header';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(mockRes.status).toHaveBeenCalledWith(204);
      // Should echo back the requested headers (permissive mode)
      expectHeader('access-control-allow-headers', 'X-Custom-Header, X-Another-Header');
    });

    it('should allow preflight with empty allowedHeaders and no requested headers', async () => {
      const handler = new CorsHandler({
        origin: 'https://example.com',
        allowedHeaders: [],
      });
      setupRequest('https://example.com', 'OPTIONS');
      mockReq.headers!['access-control-request-method'] = 'GET';

      const handled = await handleCors(handler);

      expect(handled).toBe(true);
      expect(mockRes.status).toHaveBeenCalledWith(204);
      // Should use default headers when no headers requested
      expectHeader('access-control-allow-headers', 'Content-Type, Authorization');
    });
  });
});
