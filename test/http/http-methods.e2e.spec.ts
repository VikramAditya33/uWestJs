// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Head,
  Options,
  All,
  Module,
  INestApplication,
  Res,
} from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as http from 'http';

// ============================================================================
// Controllers
// ============================================================================

@Controller('methods')
class MethodController {
  @Get()
  getHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'GET' });
  }

  @Post()
  postHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'POST' });
  }

  @Put()
  putHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'PUT' });
  }

  @Delete()
  deleteHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'DELETE' });
  }

  @Patch()
  patchHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'PATCH' });
  }
}

@Controller('head-test')
class HeadController {
  @Get('explicit-get')
  getHandler(@Res() res: UwsResponse) {
    res.setHeader('x-custom-header', 'get-value');
    res.status(200).json({ body: 'get-response' });
  }

  @Head('explicit-head')
  headHandler(@Res() res: UwsResponse) {
    res.setHeader('x-custom-header', 'head-value');
    res.status(200).send();
  }
}

@Controller('options-test')
class OptionsController {
  @Get('explicit-get')
  getHandler(@Res() res: UwsResponse) {
    res.status(200).json({ method: 'GET' });
  }

  @Options('explicit-options')
  optionsHandler(@Res() res: UwsResponse) {
    res.setHeader('x-options-header', 'options-value');
    res.status(200).end();
  }
}

@Controller('all-test')
class AllController {
  @All()
  allHandler(@Res() res: UwsResponse) {
    res.status(200).json({ handler: 'all' });
  }
}

@Module({
  controllers: [MethodController, HeadController, OptionsController, AllController],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('HTTP Methods E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13372;

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
    path: string
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown> | string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: parsed,
          });
        });
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error(`${method} ${path} timed out`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ==========================================================================
  // Standard HTTP methods
  // ==========================================================================

  describe('standard HTTP methods', () => {
    it('should handle GET requests', async () => {
      const res = await request('GET', '/methods');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ method: 'GET' });
    });

    it('should handle POST requests', async () => {
      const res = await request('POST', '/methods');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ method: 'POST' });
    });

    it('should handle PUT requests', async () => {
      const res = await request('PUT', '/methods');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ method: 'PUT' });
    });

    it('should handle DELETE requests', async () => {
      const res = await request('DELETE', '/methods');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ method: 'DELETE' });
    });

    it('should handle PATCH requests', async () => {
      const res = await request('PATCH', '/methods');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ method: 'PATCH' });
    });
  });

  // ==========================================================================
  // HEAD requests
  // ==========================================================================

  describe('HEAD requests', () => {
    it('should handle explicit HEAD route', async () => {
      const res = await request('HEAD', '/head-test/explicit-head');

      expect(res.status).toBe(200);
      expect(res.headers['x-custom-header']).toBe('head-value');
      // HEAD response must have no body
      expect(res.body).toBe('');
    });

    it('should implicitly handle HEAD for GET-only route', async () => {
      const res = await request('HEAD', '/head-test/explicit-get');

      // PR #152: HEAD implicitly matches GET routes
      expect(res.status).toBe(200);
      expect(res.headers['x-custom-header']).toBe('get-value');
      // PR #154: body is suppressed for HEAD requests
      expect(res.body).toBe('');
    });
  });

  // ==========================================================================
  // OPTIONS requests
  // ==========================================================================

  describe('OPTIONS requests', () => {
    it('should handle explicit OPTIONS route', async () => {
      const res = await request('OPTIONS', '/options-test/explicit-options');

      expect(res.status).toBe(200);
      expect(res.headers['x-options-header']).toBe('options-value');
    });

    it('should return 404 for OPTIONS to route without OPTIONS handler', async () => {
      const res = await request('OPTIONS', '/options-test/explicit-get');

      // uWebSockets.js does not auto-generate Allow header for OPTIONS (unlike Express)
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // @All() decorator
  // ==========================================================================

  describe('@All() decorator', () => {
    it('should handle GET via @All', async () => {
      const res = await request('GET', '/all-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: 'all' });
    });

    it('should handle POST via @All', async () => {
      const res = await request('POST', '/all-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: 'all' });
    });

    it('should handle PUT via @All', async () => {
      const res = await request('PUT', '/all-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: 'all' });
    });

    it('should handle DELETE via @All', async () => {
      const res = await request('DELETE', '/all-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: 'all' });
    });

    it('should handle PATCH via @All', async () => {
      const res = await request('PATCH', '/all-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ handler: 'all' });
    });

    it('should handle HEAD via @All', async () => {
      const res = await request('HEAD', '/all-test');

      expect(res.status).toBe(200);
      // PR #154: body is suppressed for HEAD requests
      expect(res.body).toBe('');
    });

    it('should handle OPTIONS via @All', async () => {
      const res = await request('OPTIONS', '/all-test');

      expect(res.status).toBe(200);
    });
  });

  // ==========================================================================
  // Method isolation
  // ==========================================================================

  describe('method isolation', () => {
    it('should not match GET handler for POST request', async () => {
      const res = await request('POST', '/head-test/explicit-get');

      expect(res.status).toBe(404);
    });

    it('should not match POST handler for GET request', async () => {
      const res = await request('GET', '/methods');

      expect(res.status).toBe(200);
      // It should match GET, not POST
      expect(res.body).toEqual({ method: 'GET' });
    });
  });
});
