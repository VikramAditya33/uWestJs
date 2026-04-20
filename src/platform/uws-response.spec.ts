/* eslint-disable @typescript-eslint/no-unused-vars */
import type { HttpResponse } from 'uWebSockets.js';
import { UwsResponse, HIGH_WATERMARK } from './uws-response';
import { Readable } from 'stream';

describe('UwsResponse', () => {
  let mockUwsRes: jest.Mocked<HttpResponse>;
  let onAbortedCallback: () => void = () => {
    throw new Error('onAbortedCallback not yet initialized - call createResponse() first');
  };
  let res: UwsResponse;

  const createResponse = () => new UwsResponse(mockUwsRes);

  beforeEach(() => {
    mockUwsRes = {
      onAborted: jest.fn((callback) => {
        onAbortedCallback = callback;
      }),
      cork: jest.fn((callback) => callback()),
      writeStatus: jest.fn(),
      writeHeader: jest.fn(),
      write: jest.fn(() => true), // Return true to indicate successful write (no backpressure)
      end: jest.fn(),
      getWriteOffset: jest.fn(() => 0),
      tryEnd: jest.fn(() => [true, false]),
      onWritable: jest.fn(),
    } as unknown as jest.Mocked<HttpResponse>;
  });

  describe('constructor', () => {
    it('should bind abort handler', () => {
      createResponse();
      expect(mockUwsRes.onAborted).toHaveBeenCalled();
    });

    it('should mark as aborted and finished when connection aborts', () => {
      res = createResponse();

      expect(res.isAborted).toBe(false);
      expect(res.isFinished).toBe(false);

      onAbortedCallback();

      expect(res.isAborted).toBe(true);
      expect(res.isFinished).toBe(true);
    });
  });

  // Helper to test chainable methods
  const expectChainable = (method: () => UwsResponse) => {
    expect(method()).toBe(res);
  };

  // Helper to test "headers already sent" errors
  const expectHeadersSentError = (method: () => void, errorMessage: string) => {
    res.send();
    expect(method).toThrow(errorMessage);
  };

  // Helper to extract and test cookie header
  const expectCookieHeader = (matcher: (value: string) => void) => {
    const cookieCall = (mockUwsRes.writeHeader as jest.Mock).mock.calls.find(
      (call) => call[0] === 'set-cookie'
    );
    expect(cookieCall).toBeDefined();
    matcher(cookieCall[1]);
  };

  describe('status()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set status code', () => {
      res.status(404);
      expect(res.statusCodeValue).toBe(404);
    });

    it('should set custom status message', () => {
      res.status(200, 'Custom OK').send();
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('200 Custom OK');
    });
  });

  describe('chainable API', () => {
    beforeEach(() => {
      res = createResponse();
    });

    const chainableMethods: Array<[string, () => UwsResponse]> = [
      ['status()', () => res.status(200)],
      ['setHeader()', () => res.setHeader('x-test', 'value')],
      ['type()', () => res.type('json')],
      ['contentType()', () => res.contentType('json')],
      ['setCookie()', () => res.setCookie('name', 'value')],
      ['cookie()', () => res.cookie('name', 'value')],
      ['clearCookie()', () => res.clearCookie('name')],
      ['location()', () => res.location('/path')],
      ['attachment()', () => res.attachment('file.txt')],
      ['append()', () => res.append('x-custom', 'value')],
      ['removeHeader()', () => res.removeHeader('x-test')],
    ];

    it.each(chainableMethods)('%s should be chainable', (_name, method) => {
      expectChainable(method);
    });
  });

  describe('headers already sent errors', () => {
    beforeEach(() => {
      res = createResponse();
    });

    const headersSentMethods: Array<[string, () => void, string]> = [
      ['status()', () => res.status(404), 'Cannot set status after headers are sent'],
      [
        'setHeader()',
        () => res.setHeader('x-custom', 'value'),
        'Cannot set headers after they are sent',
      ],
      [
        'removeHeader()',
        () => res.removeHeader('content-type'),
        'Cannot remove headers after they are sent',
      ],
      [
        'setCookie()',
        () => res.setCookie('session', 'abc123'),
        'Cannot set cookies after headers are sent',
      ],
      ['cookie()', () => res.cookie('name', 'value'), 'Cannot set cookies after headers are sent'],
    ];

    it.each(headersSentMethods)(
      '%s should throw if headers already sent',
      (_name, method, errorMessage) => {
        expectHeadersSentError(method, errorMessage);
      }
    );
  });

  describe('setHeader()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set header', () => {
      res.setHeader('content-type', 'application/json');
      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('should be case-insensitive', () => {
      res.setHeader('Content-Type', 'application/json');
      expect(res.getHeader('content-type')).toBe('application/json');
      expect(res.getHeader('Content-Type')).toBe('application/json');
    });

    it('should overwrite by default (Express behavior)', () => {
      res.setHeader('x-custom', 'first');
      res.setHeader('x-custom', 'second');
      expect(res.getHeader('x-custom')).toBe('second');
    });

    it('should accumulate when overwrite=false', () => {
      res.setHeader('set-cookie', 'session=abc', false);
      res.setHeader('set-cookie', 'user=vikram', false);
      expect(res.getHeader('set-cookie')).toEqual(['session=abc', 'user=vikram']);
    });

    it('should overwrite when overwrite=true', () => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-type', 'application/json', true);
      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('should handle array values', () => {
      res.setHeader('accept', ['text/html', 'application/json']);
      expect(res.getHeader('accept')).toEqual(['text/html', 'application/json']);
    });
  });

  describe('append()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should append to existing header', () => {
      res.setHeader('set-cookie', 'session=abc');
      res.append('set-cookie', 'user=vikram');
      expect(res.getHeader('set-cookie')).toEqual(['session=abc', 'user=vikram']);
    });

    it('should create header if it does not exist', () => {
      res.append('x-custom', 'value');
      expect(res.getHeader('x-custom')).toBe('value');
    });
  });

  describe('header()', () => {
    it('should be alias for setHeader', () => {
      res = createResponse();
      res.header('content-type', 'application/json');
      expect(res.getHeader('content-type')).toBe('application/json');
    });
  });

  describe('getHeader()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should return header value', () => {
      res.setHeader('content-type', 'application/json');
      expect(res.getHeader('content-type')).toBe('application/json');
    });

    it('should return undefined for non-existent header', () => {
      expect(res.getHeader('x-custom')).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      res.setHeader('Content-Type', 'application/json');
      expect(res.getHeader('content-type')).toBe('application/json');
      expect(res.getHeader('CONTENT-TYPE')).toBe('application/json');
    });
  });

  describe('removeHeader()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should remove header', () => {
      res.setHeader('content-type', 'application/json');
      res.removeHeader('content-type');
      expect(res.getHeader('content-type')).toBeUndefined();
    });
  });

  describe('hasHeader()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should return true if header exists', () => {
      res.setHeader('content-type', 'application/json');
      expect(res.hasHeader('content-type')).toBe(true);
    });

    it('should return false if header does not exist', () => {
      expect(res.hasHeader('content-type')).toBe(false);
    });

    it('should be case-insensitive', () => {
      res.setHeader('Content-Type', 'application/json');
      expect(res.hasHeader('content-type')).toBe(true);
      expect(res.hasHeader('CONTENT-TYPE')).toBe(true);
    });
  });

  describe('type()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set content-type header', () => {
      res.type('application/json');
      expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
    });

    it('should lookup MIME type for extension', () => {
      res.type('json');
      expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
    });

    it('should handle extension with leading dot', () => {
      res.type('.html');
      expect(res.getHeader('content-type')).toBe('text/html; charset=utf-8');
    });

    it('should handle common file extensions', () => {
      res.type('png');
      expect(res.getHeader('content-type')).toBe('image/png');
    });

    it('should accept valid MIME types with slash', () => {
      res.type('application/vnd.api+json');
      expect(res.getHeader('content-type')).toBe('application/vnd.api+json');
    });

    it.each([
      ['README', 'application/octet-stream'],
      ['unknown-extension-xyz', 'application/octet-stream'],
    ])('should fallback to application/octet-stream for %s', (input, expected) => {
      res.type(input);
      expect(res.getHeader('content-type')).toBe(expected);
    });
  });

  describe('contentType()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should be alias for type()', () => {
      res.contentType('json');
      expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
    });
  });

  describe('setCookie()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set cookie', () => {
      res.setCookie('session', 'abc123').send();
      expectCookieHeader((value) => {
        expect(value).toContain('session=abc123');
      });
    });

    it('should delete cookie when value is null', () => {
      res.setCookie('session', null).send();
      expectCookieHeader((value) => {
        expect(value).toContain('Max-Age=0');
      });
    });

    it('should set cookie with options', () => {
      res
        .setCookie('session', 'abc123', {
          path: '/api',
          httpOnly: true,
          secure: true,
        })
        .send();

      expectCookieHeader((value) => {
        expect(value).toContain('session=abc123');
        expect(value).toContain('Path=/api');
        expect(value).toContain('HttpOnly');
        expect(value).toContain('Secure');
      });
    });

    it('should sign cookie with secret', () => {
      res.setCookie('session', 'abc123', { secret: 'my-secret' }).send();

      expectCookieHeader((value) => {
        // Should have s: prefix (Express-compatible format)
        expect(value).toContain('session=s%3Aabc123.');
        expect(value).toMatch(/session=s%3Aabc123\.[a-zA-Z0-9_-]+/);
      });
    });
  });

  describe('cookie()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set cookie with string value', () => {
      res.cookie('name', 'value').send();

      expectCookieHeader((value) => {
        expect(value).toContain('name=value');
        expect(value).toContain('Path=/');
      });
    });

    it('should serialize object values to JSON', () => {
      res.cookie('cart', { items: [1, 2, 3] }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('cart=j%3A');
        expect(value).toContain(encodeURIComponent(JSON.stringify({ items: [1, 2, 3] })));
      });
    });

    it('should handle maxAge in milliseconds', () => {
      const maxAge = 900000; // 15 minutes
      res.cookie('session', 'abc123', { maxAge }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('Max-Age=900'); // Converted to seconds
        expect(value).toContain('Expires=');
      });
    });

    it('should sign cookie when signed option is true', () => {
      res.cookie('user', 'vikram', { signed: true, secret: 'my-secret' }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('user=s%3A');
        expect(value).toMatch(/user=s%3Avikram\.[a-zA-Z0-9%]+/);
      });
    });

    it('should set default path to /', () => {
      res.cookie('name', 'value').send();

      expectCookieHeader((value) => {
        expect(value).toContain('Path=/');
      });
    });

    it('should respect custom path', () => {
      res.cookie('name', 'value', { path: '/admin' }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('Path=/admin');
      });
    });
  });

  describe('clearCookie()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should clear cookie with default options', () => {
      res.clearCookie('session').send();

      expectCookieHeader((value) => {
        expect(value).toContain('session=');
        expect(value).toContain('Expires=Thu, 01 Jan 1970');
        expect(value).toContain('Path=/');
      });
    });

    it('should clear cookie with custom path', () => {
      res.clearCookie('session', { path: '/admin' }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('Path=/admin');
      });
    });

    it('should clear cookie with custom domain', () => {
      res.clearCookie('session', { domain: '.example.com' }).send();

      expectCookieHeader((value) => {
        expect(value).toContain('Domain=.example.com');
      });
    });
  });

  describe('atomic()', () => {
    it('should cork operations', () => {
      res = createResponse();
      const callback = jest.fn();

      res.atomic(callback);

      expect(mockUwsRes.cork).toHaveBeenCalledWith(callback);
      expect(callback).toHaveBeenCalled();
    });

    it('should not cork if already finished', () => {
      res = createResponse();
      const callback = jest.fn();

      res.send();
      mockUwsRes.cork = jest.fn();

      res.atomic(callback);

      expect(mockUwsRes.cork).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalled();
    });

    it('should not cork if aborted', () => {
      res = createResponse();
      const callback = jest.fn();

      onAbortedCallback();
      mockUwsRes.cork = jest.fn();

      res.atomic(callback);

      expect(mockUwsRes.cork).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('send()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should send string body', () => {
      res.send('Hello World');

      expect(mockUwsRes.cork).toHaveBeenCalled();
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('200 OK');
      expect(mockUwsRes.end).toHaveBeenCalledWith('Hello World');
      expect(res.isFinished).toBe(true);
    });

    it('should send object as JSON', () => {
      const data = { message: 'Hello' };
      res.send(data);

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith(
        'content-type',
        'application/json; charset=utf-8'
      );
      expect(mockUwsRes.end).toHaveBeenCalledWith(JSON.stringify(data));
    });

    it('should send empty response', () => {
      res.send();
      expect(mockUwsRes.end).toHaveBeenCalledWith();
    });

    it('should use custom status code', () => {
      res.status(404).send('Not Found');
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('404 Not Found');
    });

    it('should write headers before body', () => {
      res.setHeader('x-custom', 'value').send('Hello');

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('x-custom', 'value');
      expect(mockUwsRes.end).toHaveBeenCalledWith('Hello');

      // Verify order: writeHeader should be called before end
      const writeHeaderCallOrder = mockUwsRes.writeHeader.mock.invocationCallOrder[0];
      const endCallOrder = mockUwsRes.end.mock.invocationCallOrder[0];
      expect(writeHeaderCallOrder).toBeLessThan(endCallOrder);
    });

    it('should write array headers separately', () => {
      res.setHeader('set-cookie', ['session=abc', 'user=vikram']).send();

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('set-cookie', 'session=abc');
      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('set-cookie', 'user=vikram');
    });

    it('should throw if already sent', () => {
      res.send('First');
      expect(() => res.send('Second')).toThrow('Response already sent');
    });

    it('should not throw if aborted', () => {
      onAbortedCallback();
      expect(() => res.send('Hello')).not.toThrow();
      expect(mockUwsRes.end).not.toHaveBeenCalled();
    });

    it('should not auto-set content-type if already set', () => {
      res.setHeader('content-type', 'text/plain').send({ message: 'Hello' });

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('content-type', 'text/plain');
      expect(mockUwsRes.end).toHaveBeenCalledWith(JSON.stringify({ message: 'Hello' }));
    });
  });

  describe('json()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should send JSON response', () => {
      const data = { message: 'Hello', count: 42 };
      res.json(data);

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith(
        'content-type',
        'application/json; charset=utf-8'
      );
      expect(mockUwsRes.end).toHaveBeenCalledWith(JSON.stringify(data));
    });

    it('should not overwrite existing content-type', () => {
      res.setHeader('content-type', 'application/vnd.api+json').json({
        data: [],
      });

      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith(
        'content-type',
        'application/vnd.api+json'
      );
    });
  });

  describe('attachment()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set Content-Disposition header without filename', () => {
      res.attachment();
      expect(res.getHeader('content-disposition')).toBe('attachment');
    });

    it('should set Content-Disposition with filename', () => {
      res.attachment('report.pdf');
      const disposition = res.getHeader('content-disposition') as string;
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('report.pdf');
    });

    it('should set content-type based on filename extension', () => {
      res.attachment('document.pdf');
      expect(res.getHeader('content-type')).toBe('application/pdf');
    });

    it('should handle various file extensions', () => {
      res.attachment('image.png');
      expect(res.getHeader('content-type')).toBe('image/png');
      const disposition = res.getHeader('content-disposition') as string;
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('image.png');
    });

    it('should properly escape special characters in filename', () => {
      res.attachment('file with spaces.txt');
      const disposition = res.getHeader('content-disposition') as string;
      expect(disposition).toContain('attachment');
      // Spaces should be preserved within quotes
      expect(disposition).toBe('attachment; filename="file with spaces.txt"');
    });

    it('should handle unicode filenames', () => {
      res.attachment('文档.pdf');
      const disposition = res.getHeader('content-disposition') as string;
      expect(disposition).toContain('attachment');
      // Should use RFC 5987 encoding for unicode: filename*=UTF-8''encoded-filename
      expect(disposition).toMatch(/filename\*=UTF-8''/);
      expect(disposition).toContain('%E6%96%87%E6%A1%A3.pdf'); // URL-encoded "文档.pdf"
    });

    it('should handle filenames with quotes', () => {
      res.attachment('file"with"quotes.txt');
      const disposition = res.getHeader('content-disposition') as string;
      expect(disposition).toContain('attachment');
      // Quotes should be escaped with backslash
      expect(disposition).toBe('attachment; filename="file\\"with\\"quotes.txt"');
    });
  });

  describe('location()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should set Location header', () => {
      res.location('/new-path');
      expect(res.getHeader('location')).toBe('/new-path');
    });

    it('should handle absolute URLs', () => {
      res.location('https://example.com/resource');
      expect(res.getHeader('location')).toBe('https://example.com/resource');
    });

    describe('CRLF injection prevention', () => {
      const errorMessage = 'Invalid URL: control characters are not allowed in Location header';

      it.each([
        ['literal CR', '/path\rSet-Cookie: malicious=true'],
        ['literal LF', '/path\nSet-Cookie: malicious=true'],
        ['CRLF sequence', '/path\r\nSet-Cookie: malicious=true'],
        ['percent-encoded CR (%0d)', '/path%0dSet-Cookie: malicious=true'],
        ['percent-encoded LF (%0a)', '/path%0aSet-Cookie: malicious=true'],
        ['uppercase percent-encoded CR (%0D)', '/path%0DSet-Cookie: malicious=true'],
        ['uppercase percent-encoded LF (%0A)', '/path%0ASet-Cookie: malicious=true'],
        ['percent-encoded CRLF', '/path%0d%0aSet-Cookie: malicious=true'],
      ])('should reject URLs with %s', (_description, url) => {
        expect(() => res.location(url)).toThrow(errorMessage);
      });

      it.each([
        ['query parameters', '/path?param=value&other=123'],
        ['fragments', '/path#section'],
        ['properly encoded special characters', '/path?name=John%20Doe'],
      ])('should allow valid URLs with %s', (_description, url) => {
        expect(() => res.location(url)).not.toThrow();
        expect(res.getHeader('location')).toBe(url);
      });
    });
  });

  describe('redirect()', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it('should redirect with default 302 status', () => {
      res.redirect('/login');

      expect(res.statusCodeValue).toBe(302);
      expect(res.getHeader('location')).toBe('/login');
      expect(mockUwsRes.end).toHaveBeenCalled();
    });

    it('should redirect with custom status code', () => {
      res.redirect('/new-location', 301);

      expect(res.statusCodeValue).toBe(301);
      expect(res.getHeader('location')).toBe('/new-location');
      expect(mockUwsRes.end).toHaveBeenCalled();
    });

    it('should handle 303 See Other redirect', () => {
      res.redirect('/success', 303);

      expect(res.statusCodeValue).toBe(303);
      expect(res.getHeader('location')).toBe('/success');
    });

    it('should handle absolute URLs', () => {
      res.redirect('https://example.com/external', 307);

      expect(res.statusCodeValue).toBe(307);
      expect(res.getHeader('location')).toBe('https://example.com/external');
    });

    describe('CRLF injection prevention', () => {
      const errorMessage = 'Invalid URL: control characters are not allowed in Location header';

      it.each([
        ['CRLF sequence', '/path\r\nSet-Cookie: malicious=true'],
        ['percent-encoded CRLF', '/path%0d%0aSet-Cookie: malicious=true'],
      ])('should reject redirect URLs with %s', (_description, url) => {
        expect(() => res.redirect(url)).toThrow(errorMessage);
      });
    });
  });

  describe('end()', () => {
    it('should write chunk and finalize response', (done) => {
      res = createResponse();
      res.end('Hello', () => {
        expect(mockUwsRes.write).toHaveBeenCalled();
        expect(mockUwsRes.end).toHaveBeenCalled();
        expect(res.isFinished).toBe(true);
        done();
      });
    });
  });

  describe('method chaining integration', () => {
    it('should support chaining multiple methods together', () => {
      res = createResponse();

      res
        .status(201)
        .setHeader('x-custom', 'value')
        .type('json')
        .setCookie('session', 'abc123')
        .send({ created: true });

      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('201 Created');
      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('x-custom', 'value');
      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith(
        'content-type',
        'application/json; charset=utf-8'
      );
      expect(res.isFinished).toBe(true);
    });
  });

  describe('state getters', () => {
    beforeEach(() => {
      res = createResponse();
    });

    it.each([
      ['finished', 'isFinished', () => res.send()],
      ['aborted', 'isAborted', () => onAbortedCallback()],
      ['headers sent', 'headersSent', () => res.send()],
    ])('should track %s state', (_description, property, trigger) => {
      expect(res[property as keyof UwsResponse]).toBe(false);
      trigger();
      expect(res[property as keyof UwsResponse]).toBe(true);
    });

    it('should return status code', () => {
      res.status(404);
      expect(res.statusCodeValue).toBe(404);
    });
  });

  describe('writeChunk() - chunk batching', () => {
    beforeEach(() => {
      res = createResponse();
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should write headers on first write', () => {
      res.status(200).setHeader('content-type', 'text/plain');
      res.writeChunk('Hello');

      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('200 OK');
      expect(mockUwsRes.writeHeader).toHaveBeenCalledWith('content-type', 'text/plain');
    });

    it('should flush first chunk immediately', () => {
      res.writeChunk('First chunk');

      expect(mockUwsRes.write).toHaveBeenCalledTimes(1);
      expect(mockUwsRes.write).toHaveBeenCalledWith(Buffer.from('First chunk'));
    });

    it('should batch subsequent small chunks', () => {
      res.writeChunk('First');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1);

      res.writeChunk(' Second');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1); // Still 1, batched

      res.writeChunk(' Third');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1); // Still 1, batched
    });

    it('should flush when HIGH_WATERMARK (128KB) is reached', () => {
      res.writeChunk('First');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1);

      // Write HIGH_WATERMARK to trigger flush
      const largeChunk = Buffer.alloc(HIGH_WATERMARK);
      res.writeChunk(largeChunk);

      expect(mockUwsRes.write).toHaveBeenCalledTimes(2);
    });

    it('should flush after FLUSH_INTERVAL (50ms) timeout', () => {
      res.writeChunk('First');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1);

      res.writeChunk(' Second');
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1); // Batched

      // Advance time by 50ms
      jest.advanceTimersByTime(50);

      expect(mockUwsRes.write).toHaveBeenCalledTimes(2); // Flushed
    });

    it('should handle Buffer chunks', () => {
      const buffer = Buffer.from('Hello Buffer');
      res.writeChunk(buffer);

      expect(mockUwsRes.write).toHaveBeenCalledWith(buffer);
    });

    it('should handle ArrayBuffer chunks', () => {
      const arrayBuffer = new ArrayBuffer(5);
      const view = new Uint8Array(arrayBuffer);
      view.set([72, 101, 108, 108, 111]); // "Hello"

      res.writeChunk(arrayBuffer);

      expect(mockUwsRes.write).toHaveBeenCalledWith(Buffer.from(arrayBuffer));
    });

    it('should handle string chunks with encoding', () => {
      res.writeChunk('Hello', 'utf8');

      expect(mockUwsRes.write).toHaveBeenCalledWith(Buffer.from('Hello', 'utf8'));
    });

    it('should return false if response is finished', () => {
      res.send();
      const result = res.writeChunk('Too late');

      expect(result).toBe(false);
      expect(mockUwsRes.write).not.toHaveBeenCalled();
    });

    it('should return false if response is aborted', () => {
      onAbortedCallback();
      const result = res.writeChunk('Too late');

      expect(result).toBe(false);
      expect(mockUwsRes.write).not.toHaveBeenCalled();
    });

    it('should clear timeout on abort', () => {
      res.writeChunk('First');
      res.writeChunk(' Second'); // Batched, timeout scheduled

      onAbortedCallback();

      // Advance time - should not flush
      jest.advanceTimersByTime(50);
      expect(mockUwsRes.write).toHaveBeenCalledTimes(1); // Only first chunk
    });

    it('should flush pending chunks before send()', () => {
      res.writeChunk('First');
      res.writeChunk(' Second'); // Batched

      res.send(' Final');

      // Should have flushed batched chunks, then sent final
      expect(mockUwsRes.write).toHaveBeenCalledTimes(2);
      expect(mockUwsRes.end).toHaveBeenCalledWith(' Final');
    });

    it('should concatenate multiple pending chunks correctly', () => {
      res.writeChunk('First');
      res.writeChunk(' Second');
      res.writeChunk(' Third');

      jest.advanceTimersByTime(50);

      const writeCall = (mockUwsRes.write as jest.Mock).mock.calls[1];
      expect(writeCall[0].toString()).toBe(' Second Third');
    });

    it('should not prevent process exit (unref timeout)', () => {
      const unrefSpy = jest.fn();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
        callback: () => void
      ) => {
        const timeout = { unref: unrefSpy };
        return timeout as any;
      }) as any);

      try {
        res.writeChunk('First');
        res.writeChunk(' Second');

        expect(unrefSpy).toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  // Helper to create a proper Readable stream for manual read() testing
  const createManualReadable = (chunks: Buffer[]) => {
    const remaining = [...chunks];
    return new Readable({
      read() {
        if (remaining.length === 0) {
          this.push(null);
        } else {
          this.push(remaining.shift()!);
        }
      },
    });
  };

  describe('stream() - streaming with backpressure', () => {
    beforeEach(() => {
      jest.useRealTimers();
      res = createResponse();
    });

    it('should stream readable with chunked encoding (no totalSize)', async () => {
      (mockUwsRes.write as jest.Mock).mockReturnValue(true);

      const readable = createManualReadable([
        Buffer.from('chunk1'),
        Buffer.from('chunk2'),
        Buffer.from('chunk3'),
      ]);

      await res.stream(readable);

      expect(mockUwsRes.write).toHaveBeenCalled();
      expect(mockUwsRes.end).toHaveBeenCalled();
      expect(res.isFinished).toBe(true);
    });

    it('should stream readable with content-length (with totalSize)', async () => {
      const readable = Readable.from([Buffer.from('hello')]);
      const totalSize = 5;

      (mockUwsRes.tryEnd as jest.Mock).mockReturnValue([true, true]);

      await res.stream(readable, totalSize);

      expect(mockUwsRes.tryEnd).toHaveBeenCalledWith(Buffer.from('hello'), totalSize);
      expect(res.getHeader('content-length')).toBe('5');
      expect(res.isFinished).toBe(true);
    });

    it('should set content-length header when totalSize provided', async () => {
      const readable = Readable.from(['test']);

      (mockUwsRes.tryEnd as jest.Mock).mockReturnValue([true, true]);

      await res.stream(readable, 100);

      expect(res.getHeader('content-length')).toBe('100');
    });

    it('should handle backpressure with onWritable', async () => {
      const readable = Readable.from([Buffer.from('large chunk')]);

      // Simulate backpressure on first write
      (mockUwsRes.write as jest.Mock).mockReturnValueOnce(false).mockReturnValueOnce(true);
      (mockUwsRes.getWriteOffset as jest.Mock).mockReturnValue(0);

      let writableCallback: ((offset: number) => boolean) | undefined;
      (mockUwsRes.onWritable as jest.Mock).mockImplementation((cb) => {
        writableCallback = cb;
        // Simulate drain event after a tick
        setImmediate(() => writableCallback!(0));
      });

      await res.stream(readable);

      expect(mockUwsRes.onWritable).toHaveBeenCalled();
      expect(mockUwsRes.write).toHaveBeenCalledTimes(2);
    });

    it('should handle backpressure with tryEnd', async () => {
      const readable = Readable.from([Buffer.from('data')]);

      // Simulate backpressure on first tryEnd
      (mockUwsRes.tryEnd as jest.Mock)
        .mockReturnValueOnce([false, false])
        .mockReturnValueOnce([true, true]);
      (mockUwsRes.getWriteOffset as jest.Mock).mockReturnValue(0);

      let writableCallback: ((offset: number) => boolean) | undefined;
      (mockUwsRes.onWritable as jest.Mock).mockImplementation((cb) => {
        writableCallback = cb;
        setImmediate(() => writableCallback!(0));
      });

      await res.stream(readable, 4);

      expect(mockUwsRes.onWritable).toHaveBeenCalled();
      expect(mockUwsRes.tryEnd).toHaveBeenCalledTimes(2);
    });

    it('should not stream if aborted', async () => {
      const readable = createManualReadable([Buffer.from('chunk')]);

      onAbortedCallback();

      await res.stream(readable);

      expect(mockUwsRes.write).not.toHaveBeenCalled();
    });

    it('should destroy stream and resolve when aborted during streaming', async () => {
      // Create a stream that waits for data (simulates slow stream)
      const readable = new Readable({
        read() {
          // Don't push anything - stream is waiting
        },
      });

      const destroySpy = jest.spyOn(readable, 'destroy');

      // Start streaming (will wait for data)
      const streamPromise = res.stream(readable);

      // Simulate abort after stream() starts waiting
      await new Promise((resolve) => setImmediate(resolve));
      onAbortedCallback();

      // Stream should resolve (not hang) and destroy should be called
      await expect(streamPromise).resolves.toBeUndefined();
      expect(destroySpy).toHaveBeenCalled();
    });

    it('should not stream if already finished', async () => {
      const readable = Readable.from(['chunk']);

      res.send();
      await res.stream(readable);

      expect(mockUwsRes.write).not.toHaveBeenCalled();
    });

    it('should handle stream errors', async () => {
      const readable = new Readable({
        read() {
          // Emit error event
          process.nextTick(() => {
            this.emit('error', new Error('Stream error'));
          });
        },
      });

      await expect(res.stream(readable)).rejects.toThrow('Stream error');
    });

    it('should handle partial writes with offset', async () => {
      const chunk = Buffer.from('hello world');
      let callCount = 0;

      const readable = new Readable({
        read() {
          if (callCount === 0) {
            this.push(chunk);
          } else {
            this.push(null);
          }
          callCount++;
        },
      });

      // Simulate partial write - only 5 bytes sent initially
      (mockUwsRes.write as jest.Mock).mockReturnValueOnce(false);
      (mockUwsRes.getWriteOffset as jest.Mock).mockReturnValueOnce(0).mockReturnValueOnce(5);

      let writableCallback: ((offset: number) => boolean) | undefined;
      (mockUwsRes.onWritable as jest.Mock).mockImplementation((cb) => {
        writableCallback = cb;
        setImmediate(() => {
          // Simulate drain with offset 5 (5 bytes already sent)
          (mockUwsRes.write as jest.Mock).mockReturnValueOnce(true);
          writableCallback!(5);
        });
      });

      await res.stream(readable);

      // Should have called write twice - once failed, once succeeded with remaining
      expect(mockUwsRes.write).toHaveBeenCalledTimes(2);
      const secondCall = (mockUwsRes.write as jest.Mock).mock.calls[1];
      expect(secondCall[0].toString()).toBe(' world');
    });
  });

  describe('pipeFrom()', () => {
    beforeEach(() => {
      jest.useRealTimers();
      res = createResponse();
    });

    it('should pipe readable stream to response', (done) => {
      const readable = createManualReadable([
        Buffer.from('chunk1'),
        Buffer.from('chunk2'),
        Buffer.from('chunk3'),
      ]);

      res.pipeFrom(readable);

      readable.on('end', () => {
        setImmediate(() => {
          expect(mockUwsRes.write).toHaveBeenCalled();
          expect(mockUwsRes.end).toHaveBeenCalled();
          done();
        });
      });
    });

    it('should handle stream errors', async () => {
      const readable = new Readable({
        read() {
          process.nextTick(() => {
            this.destroy(new Error('Stream error'));
          });
        },
      });

      // Listen for error event
      const errorHandler = jest.fn();
      res.on('error', errorHandler);

      res.pipeFrom(readable);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should send 500 error response when stream fails
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('500 Internal Server Error');
      // Verify error event was emitted
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Stream error' })
      );
    });

    it('should be chainable', () => {
      const readable = Readable.from(['test']);

      expectChainable(() => res.pipeFrom(readable));
    });

    it('should not send error if headers already sent', async () => {
      const readable = new Readable({
        read() {
          setImmediate(() => {
            this.destroy(new Error('Stream error'));
          });
        },
      });

      res.send('Already sent');
      res.pipeFrom(readable);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockUwsRes.writeStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('Standard Node.js pipe() - Writable interface', () => {
    beforeEach(() => {
      jest.useRealTimers();
      res = createResponse();
    });

    it('should work with standard readable.pipe(writable) pattern', (done) => {
      const readable = Readable.from(['Hello', ' ', 'World']);

      readable.pipe(res);

      readable.on('end', () => {
        setImmediate(() => {
          expect(mockUwsRes.write).toHaveBeenCalled();
          done();
        });
      });
    });

    it('should handle backpressure via Writable callback mechanism', (done) => {
      const chunks: string[] = [];

      const readable = new Readable({
        read() {
          if (chunks.length < 3) {
            chunks.push(`chunk${chunks.length + 1}`);
            this.push(`chunk${chunks.length}`);
          } else {
            this.push(null);
          }
        },
      });

      readable.pipe(res);

      readable.on('end', () => {
        setImmediate(() => {
          expect(mockUwsRes.write).toHaveBeenCalled();
          done();
        });
      });
    });
  });
});
