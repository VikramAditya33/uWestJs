// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Module, INestApplication, Req, Res } from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsRequest } from '../../src/http/core/request';
import { UwsResponse } from '../../src/http/core/response';
import * as http from 'http';

// ============================================================================
// Controllers
// ============================================================================

@Controller('headers-test')
class HeadersController {
  @Get('set-single')
  setSingle(@Res() res: UwsResponse) {
    res.setHeader('x-custom', 'hello');
    res.status(200).send({ ok: true });
  }

  @Get('set-multiple')
  setMultiple(@Res() res: UwsResponse) {
    res.setHeader('x-first', 'one');
    res.setHeader('x-second', 'two');
    res.status(200).send({ ok: true });
  }

  @Get('overwrite')
  overwrite(@Res() res: UwsResponse) {
    res.setHeader('x-dynamic', 'first');
    res.setHeader('x-dynamic', 'second');
    res.status(200).send({ ok: true });
  }

  @Get('append')
  append(@Res() res: UwsResponse) {
    res.setHeader('x-list', 'a');
    res.append('x-list', 'b');
    res.append('x-list', 'c');
    res.status(200).send({ ok: true });
  }

  @Get('remove')
  remove(@Res() res: UwsResponse) {
    res.setHeader('x-removed', 'gone');
    res.removeHeader('x-removed');
    res.status(200).send({ ok: true });
  }

  @Get('content-type')
  contentType(@Res() res: UwsResponse) {
    res.type('json');
    res.status(200).send('{"raw":true}');
  }
}

@Controller('cookie-test')
class CookieController {
  @Get('set-simple')
  setSimple(@Res() res: UwsResponse) {
    res.cookie('session', 'abc123');
    res.status(200).send({ ok: true });
  }

  @Get('set-options')
  setOptions(@Res() res: UwsResponse) {
    res.cookie('pref', 'dark', {
      httpOnly: true,
      sameSite: 'strict',
      path: '/cookie-test',
    });
    res.status(200).send({ ok: true });
  }

  @Get('set-signed')
  setSigned(@Res() res: UwsResponse) {
    res.cookie('auth', 'token', {
      signed: true,
      secret: 'test-secret',
    });
    res.status(200).send({ ok: true });
  }

  @Get('set-json')
  setJson(@Res() res: UwsResponse) {
    res.cookie('data', { user: 42, role: 'admin' });
    res.status(200).send({ ok: true });
  }

  @Get('clear')
  clear(@Res() res: UwsResponse) {
    res.clearCookie('session');
    res.status(200).send({ ok: true });
  }

  @Get('multiple')
  multiple(@Res() res: UwsResponse) {
    res.cookie('a', '1');
    res.cookie('b', '2');
    res.cookie('c', '3');
    res.status(200).send({ ok: true });
  }

  @Get('parse')
  parse(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    res.status(200).send({ cookies: req.cookies });
  }

  @Get('parse-signed')
  parseSigned(@Req() req: UwsRequest, @Res() res: UwsResponse) {
    req._setCookieSecret('test-secret');
    res.status(200).send({
      signedCookies: req.signedCookies,
    });
  }
}

@Module({
  controllers: [HeadersController, CookieController],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Headers and Cookies E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13362;

  beforeAll(async () => {
    const adapter = new UwsPlatformAdapter({
      port,
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

  function request(
    method: string,
    path: string,
    opts?: { body?: unknown; headers?: Record<string, string>; cookies?: string }
  ): Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    body: Record<string, unknown>;
  }> {
    return new Promise((resolve, reject) => {
      const postData = opts?.body ? JSON.stringify(opts.body) : undefined;
      const headers: Record<string, string> = { ...(opts?.headers || {}) };
      if (postData) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }
      if (opts?.cookies) {
        headers['Cookie'] = opts.cookies;
      }

      const req = http.request(`${baseUrl}${path}`, { method, agent: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { raw };
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[]>,
            body: parsed,
          });
        });
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error(`${method} ${path} timed out`));
      });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  // ==========================================================================
  // Response Headers
  // ==========================================================================

  describe('response headers', () => {
    it('should set a single custom header', async () => {
      const res = await request('GET', '/headers-test/set-single');

      expect(res.status).toBe(200);
      expect(res.headers['x-custom']).toBe('hello');
    });

    it('should set multiple distinct headers', async () => {
      const res = await request('GET', '/headers-test/set-multiple');

      expect(res.status).toBe(200);
      expect(res.headers['x-first']).toBe('one');
      expect(res.headers['x-second']).toBe('two');
    });

    it('should overwrite header with same name', async () => {
      const res = await request('GET', '/headers-test/overwrite');

      expect(res.status).toBe(200);
      expect(res.headers['x-dynamic']).toBe('second');
    });

    it('should append values to same header', async () => {
      const res = await request('GET', '/headers-test/append');

      expect(res.status).toBe(200);
      // Node.js http joins multi-value headers with comma+space per RFC 2616
      const values = res.headers['x-list'];
      expect(values).toBe('a, b, c');
    });

    it('should remove a header', async () => {
      const res = await request('GET', '/headers-test/remove');

      expect(res.status).toBe(200);
      expect(res.headers['x-removed']).toBeUndefined();
    });

    it('should set content-type via type()', async () => {
      const res = await request('GET', '/headers-test/content-type');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ==========================================================================
  // Response Cookies
  // ==========================================================================

  describe('response cookies', () => {
    it('should set a simple cookie', async () => {
      const res = await request('GET', '/cookie-test/set-simple');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(cookies.some((c: string) => c.startsWith('session=abc123'))).toBe(true);
    });

    it('should set cookie with options (httpOnly, sameSite, path)', async () => {
      const res = await request('GET', '/cookie-test/set-options');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toContain('HttpOnly');
      expect(cookieStr).toContain('SameSite=Strict');
      expect(cookieStr).toContain('Path=/cookie-test');
    });

    it('should set a signed cookie', async () => {
      const res = await request('GET', '/cookie-test/set-signed');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/^auth=s%3A/); // 's:' URL-encoded is 's%3A'
    });

    it('should set a JSON cookie', async () => {
      const res = await request('GET', '/cookie-test/set-json');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      // JSON cookies are prefixed with 'j:'
      expect(cookieStr).toContain('data=j%3A');
    });

    it('should clear a cookie', async () => {
      const res = await request('GET', '/cookie-test/clear');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toContain('session=');
      expect(cookieStr).toContain('Expires=');
    });

    it('should set multiple cookies', async () => {
      const res = await request('GET', '/cookie-test/multiple');

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'];
      expect(Array.isArray(setCookie)).toBe(true);
      const cookies = setCookie as string[];
      expect(cookies.length).toBe(3);
      expect(cookies.some((c) => c.startsWith('a=1'))).toBe(true);
      expect(cookies.some((c) => c.startsWith('b=2'))).toBe(true);
      expect(cookies.some((c) => c.startsWith('c=3'))).toBe(true);
    });
  });

  // ==========================================================================
  // Request Cookie Parsing
  // ==========================================================================

  describe('request cookie parsing', () => {
    it('should parse cookies from request header', async () => {
      const res = await request('GET', '/cookie-test/parse', {
        cookies: 'session=abc123; user=vikram',
      });

      expect(res.status).toBe(200);
      expect(res.body.cookies).toMatchObject({
        session: 'abc123',
        user: 'vikram',
      });
    });

    it('should return empty object when no cookies', async () => {
      const res = await request('GET', '/cookie-test/parse');

      expect(res.status).toBe(200);
      expect(res.body.cookies).toEqual({});
    });

    it('should parse signed cookies with valid secret', async () => {
      // First get a signed cookie from the server
      const setRes = await request('GET', '/cookie-test/set-signed');
      const setCookieHeader = setRes.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      const cookiePair = cookieStr.split(';')[0];

      // Send it back to parse-signed endpoint
      const res = await request('GET', '/cookie-test/parse-signed', {
        cookies: cookiePair,
      });

      expect(res.status).toBe(200);
      expect(res.body.signedCookies).toBeDefined();
      // The signed cookie value should be decoded
      expect(res.body.signedCookies.auth).toBeDefined();
    });

    it('should reject tampered signed cookies', async () => {
      const res = await request('GET', '/cookie-test/parse-signed', {
        cookies: 'auth=tampered.value.here',
      });

      expect(res.status).toBe(200);
      expect(res.body.signedCookies).toEqual({});
    });
  });
});
