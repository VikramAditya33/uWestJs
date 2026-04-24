import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { RouteRegistry } from './route-registry';
import type { PlatformOptions } from '../../shared/interfaces';
import { createMockUwsApp, createMockUwsRequest, createMockUwsResponse } from '../test-helpers';

type UwsHandler = (res: HttpResponse, req: HttpRequest) => void;

describe('RouteRegistry', () => {
  let mockUwsApp: any;
  let registry: RouteRegistry;
  let registeredRoutes: Map<string, { path: string; handler: UwsHandler }>;
  const options: PlatformOptions = {
    maxBodySize: 1024 * 1024,
  };

  // Helper to create mock uWS request/response
  const createMockUwsReqRes = (method = 'get', url = '/error') => {
    const mockUwsReq = createMockUwsRequest({
      method,
      url,
    });

    const { mockRes } = createMockUwsResponse();

    return { mockUwsRes: mockRes, mockUwsReq };
  };

  beforeEach(() => {
    // Create mock uWS app with route tracking
    const { mockApp, registeredRoutes: routes } = createMockUwsApp({ trackRoutes: true });
    mockUwsApp = mockApp;
    registeredRoutes = routes;

    registry = new RouteRegistry(mockUwsApp, options);
  });

  describe('register', () => {
    // Test all HTTP methods with a data-driven approach
    const methodTests = [
      { method: 'GET', uwsMethod: 'get', path: '/users' },
      { method: 'POST', uwsMethod: 'post', path: '/users' },
      { method: 'PUT', uwsMethod: 'put', path: '/users/:id' },
      { method: 'DELETE', uwsMethod: 'del', path: '/users/:id' },
      { method: 'PATCH', uwsMethod: 'patch', path: '/users/:id' },
      { method: 'OPTIONS', uwsMethod: 'options', path: '/users' },
      { method: 'HEAD', uwsMethod: 'head', path: '/users' },
      { method: 'ALL', uwsMethod: 'any', path: '/users' },
    ];

    methodTests.forEach(({ method, uwsMethod, path }) => {
      it(`should register ${method} route`, () => {
        const handler = jest.fn();
        registry.register(method, path, handler);

        expect(mockUwsApp[uwsMethod]).toHaveBeenCalledWith(path, expect.any(Function));
        expect(registry.hasRoute(method, path)).toBe(true);
      });
    });

    it('should throw error for invalid HTTP method', () => {
      expect(() => {
        registry.register('INVALID', '/users', jest.fn());
      }).toThrow('Unsupported HTTP method: INVALID');
    });

    it('should handle case-insensitive method names', () => {
      registry.register('get', '/users', jest.fn());
      expect(mockUwsApp.get).toHaveBeenCalledWith('/users', expect.any(Function));
      // Verify route lookup is also case-insensitive
      expect(registry.hasRoute('GET', '/users')).toBe(true);
    });
  });

  describe('path handling', () => {
    const pathTests = [
      { desc: 'single parameter', path: '/users/:id' },
      { desc: 'multiple parameters', path: '/users/:userId/posts/:postId' },
      { desc: 'no parameters', path: '/users' },
      { desc: 'complex path', path: '/api/v1/users/:userId/posts/:postId/comments/:commentId' },
      { desc: 'trailing slash', path: '/users/' },
      { desc: 'root path', path: '/' },
    ];

    pathTests.forEach(({ desc, path }) => {
      it(`should handle path with ${desc}`, () => {
        registry.register('GET', path, jest.fn());
        expect(mockUwsApp.get).toHaveBeenCalledWith(path, expect.any(Function));
      });
    });
  });

  describe('route tracking', () => {
    it('should track registered routes', () => {
      registry.register('GET', '/users', jest.fn());
      registry.register('POST', '/users', jest.fn());
      registry.register('GET', '/posts', jest.fn());

      expect(registry.getRouteCount()).toBe(3);
    });

    it('should check if route exists', () => {
      registry.register('GET', '/users', jest.fn());

      expect(registry.hasRoute('GET', '/users')).toBe(true);
      expect(registry.hasRoute('POST', '/users')).toBe(false);
      expect(registry.hasRoute('GET', '/posts')).toBe(false);
    });

    it('should return all registered routes', () => {
      registry.register('GET', '/users', jest.fn());
      registry.register('POST', '/users', jest.fn());

      const routes = registry.getRoutes();
      expect(routes.size).toBe(2);
      expect(routes.has('GET:/users')).toBe(true);
      expect(routes.has('POST:/users')).toBe(true);
    });
  });

  describe('optional parameters', () => {
    it('should handle optional single parameter', () => {
      registry.register('GET', '/users/:id?', jest.fn());

      const routes = registry.getRoutes();
      const route = routes.get('GET:/users/:id?');

      expect(route).toBeDefined();
      expect(route?.isComplex).toBe(true);
      expect(route?.pattern).toBeInstanceOf(RegExp);
    });

    it('should handle multiple optional parameters', () => {
      registry.register('GET', '/posts/:year?/:month?/:day?', jest.fn());

      const routes = registry.getRoutes();
      const route = routes.get('GET:/posts/:year?/:month?/:day?');

      expect(route).toBeDefined();
      expect(route?.isComplex).toBe(true);
      expect(route?.paramNames).toEqual(['year', 'month', 'day']);
    });

    it('should handle mix of required and optional parameters', () => {
      registry.register('GET', '/api/:version/users/:id?', jest.fn());

      const routes = registry.getRoutes();
      const route = routes.get('GET:/api/:version/users/:id?');

      expect(route).toBeDefined();
      expect(route?.isComplex).toBe(true);
      expect(route?.paramNames).toEqual(['version', 'id']);
    });

    it('should register complex routes with specific wildcard pattern', () => {
      registry.register('GET', '/users/:id?', jest.fn());

      // Complex routes should register with /users/* pattern (static prefix + /*)
      expect(mockUwsApp.get).toHaveBeenCalledWith('/users/*', expect.any(Function));
    });
  });

  describe('optional parameter matching', () => {
    it('should match route with optional parameter present', () => {
      const handler = jest.fn();
      registry.register('GET', '/users/:id?', handler);

      const uwsHandler = registeredRoutes.get('GET:/users/*')?.handler;
      expect(uwsHandler).toBeDefined();

      // Manually test the regex matching
      const routes = registry.getRoutes();
      const route = routes.get('GET:/users/:id?');
      expect(route).toBeDefined();
      expect(route?.pattern).toBeInstanceOf(RegExp);

      const pattern = route?.pattern as RegExp;
      const match = pattern.exec('/users/123');
      expect(match).not.toBeNull();
      expect(match?.groups?.id).toBe('123');
    });

    it('should match route with optional parameter absent', () => {
      const handler = jest.fn();
      registry.register('GET', '/users/:id?', handler);

      const routes = registry.getRoutes();
      const route = routes.get('GET:/users/:id?');
      const pattern = route?.pattern as RegExp;

      const match = pattern.exec('/users');
      expect(match).not.toBeNull();
      expect(match?.groups?.id).toBeUndefined();
    });

    it('should match route with multiple optional parameters', () => {
      const handler = jest.fn();
      registry.register('GET', '/posts/:year?/:month?/:day?', handler);

      const routes = registry.getRoutes();
      const route = routes.get('GET:/posts/:year?/:month?/:day?');
      const pattern = route?.pattern as RegExp;

      // All present
      let match = pattern.exec('/posts/2024/04/15');
      expect(match).not.toBeNull();
      expect(match?.groups?.year).toBe('2024');
      expect(match?.groups?.month).toBe('04');
      expect(match?.groups?.day).toBe('15');

      // Only year
      match = pattern.exec('/posts/2024');
      expect(match).not.toBeNull();
      expect(match?.groups?.year).toBe('2024');
      expect(match?.groups?.month).toBeUndefined();
      expect(match?.groups?.day).toBeUndefined();

      // None
      match = pattern.exec('/posts');
      expect(match).not.toBeNull();
      expect(match?.groups?.year).toBeUndefined();
    });

    it('should not match incorrect paths', () => {
      const handler = jest.fn();
      registry.register('GET', '/users/:id?', handler);

      const routes = registry.getRoutes();
      const route = routes.get('GET:/users/:id?');
      const pattern = route?.pattern as RegExp;

      // Should not match different paths
      expect(pattern.exec('/posts')).toBeNull();
      expect(pattern.exec('/users/123/posts')).toBeNull();
      expect(pattern.exec('/api/users')).toBeNull();
    });

    it('should match wildcard-only routes without parameters', () => {
      const handler = jest.fn();
      registry.register('GET', '/files/*', handler);

      const routes = registry.getRoutes();
      const route = routes.get('GET:/files/*');
      expect(route).toBeDefined();
      expect(route?.pattern).toBeInstanceOf(RegExp);

      const pattern = route?.pattern as RegExp;

      // Should match any path under /files/
      const match1 = pattern.exec('/files/document.pdf');
      expect(match1).not.toBeNull();
      expect(match1?.groups).toBeUndefined(); // No named groups for wildcard-only

      const match2 = pattern.exec('/files/images/photo.jpg');
      expect(match2).not.toBeNull();

      // Should not match /files without trailing path
      expect(pattern.exec('/files')).toBeNull();
    });
  });

  describe('multiple complex routes with same prefix', () => {
    it('should route to correct handler when multiple optional-parameter routes share a prefix', async () => {
      const handler1 = jest.fn(async (_req, res) => {
        res.send({ route: 'handler1' });
      });
      const handler2 = jest.fn(async (_req, res) => {
        res.send({ route: 'handler2' });
      });

      // Register two routes with semantically equivalent patterns (different param names)
      // Both match /users and /users/{anything}, demonstrating "first match wins" behavior
      registry.register('GET', '/users/:id?', handler1);
      registry.register('GET', '/users/:name?', handler2);

      // Both routes should be registered
      expect(registry.hasRoute('GET', '/users/:id?')).toBe(true);
      expect(registry.hasRoute('GET', '/users/:name?')).toBe(true);

      // Get the wildcard handler that was registered with uWS
      const wildcardKey = 'GET:/users/*';
      const registeredHandler = registeredRoutes.get(wildcardKey)?.handler;
      expect(registeredHandler).toBeDefined();

      // Test that the first matching route is used (Express-compatible behavior)
      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      mockUwsReq.getUrl = jest.fn(() => '/users/123');

      await registeredHandler!(mockUwsRes, mockUwsReq);

      // First handler should be called (first match wins)
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should handle multiple complex routes with different patterns under same prefix', async () => {
      const shortHandler = jest.fn(async (req, res) => {
        res.send({ route: 'short', year: req.params.year });
      });
      const longHandler = jest.fn(async (req, res) => {
        res.send({ route: 'long', year: req.params.year, month: req.params.month });
      });

      // Register routes with same prefix but different optional parameter counts
      // Order matters: first registered route takes precedence (first match wins)
      registry.register('GET', '/posts/:year?/:month?', longHandler);
      registry.register('GET', '/posts/:year?', shortHandler);

      // Both routes should be registered
      expect(registry.hasRoute('GET', '/posts/:year?/:month?')).toBe(true);
      expect(registry.hasRoute('GET', '/posts/:year?')).toBe(true);

      // Get the wildcard handler
      const wildcardKey = 'GET:/posts/*';
      const registeredHandler = registeredRoutes.get(wildcardKey)?.handler;
      expect(registeredHandler).toBeDefined();

      // Test /posts/2024 - should match first route (first match wins)
      const { mockUwsRes: res1, mockUwsReq: req1 } = createMockUwsReqRes();
      req1.getUrl = jest.fn(() => '/posts/2024');

      await registeredHandler!(res1, req1);

      // First route pattern /posts/:year?/:month? matches /posts/2024
      // (year=2024, month=undefined)
      expect(longHandler).toHaveBeenCalled();
      expect(shortHandler).not.toHaveBeenCalled();

      // Reset mocks
      longHandler.mockClear();
      shortHandler.mockClear();

      // Test /posts/2024/04 - should match first route
      const { mockUwsRes: res2, mockUwsReq: req2 } = createMockUwsReqRes();
      req2.getUrl = jest.fn(() => '/posts/2024/04');

      await registeredHandler!(res2, req2);

      // First route pattern /posts/:year?/:month? matches /posts/2024/04
      expect(longHandler).toHaveBeenCalled();
      expect(shortHandler).not.toHaveBeenCalled();
    });
  });

  describe('duplicate route detection', () => {
    it('should throw error when registering duplicate route', () => {
      registry.register('GET', '/users', jest.fn());

      expect(() => {
        registry.register('GET', '/users', jest.fn());
      }).toThrow('Route already registered: GET /users');
    });

    it('should allow same path with different methods', () => {
      registry.register('GET', '/users', jest.fn());
      registry.register('POST', '/users', jest.fn());

      expect(registry.hasRoute('GET', '/users')).toBe(true);
      expect(registry.hasRoute('POST', '/users')).toBe(true);
      expect(registry.getRouteCount()).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should handle errors in route handler', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Handler error'));
      registry.register('GET', '/error', handler);

      const uwsHandler = registeredRoutes.get('GET:/error')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();

      await uwsHandler!(mockUwsRes, mockUwsReq);

      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('500 Internal Server Error');
      expect(mockUwsRes.end).toHaveBeenCalled();
    });

    it('should log error if headers already sent', async () => {
      const loggerErrorSpy = jest.fn();
      const mockLogger = {
        error: loggerErrorSpy,
      };

      // Create registry with custom logger
      const registryWithLogger = new RouteRegistry(mockUwsApp, {
        maxBodySize: 1024 * 1024,
        logger: mockLogger,
      });

      const handler = jest.fn(async (_req, res) => {
        // Start sending response (this marks headers as sent)
        res.status(200);
        res.setHeader('Content-Type', 'application/json');

        // Simulate headers being sent by calling writeHead through send
        // We mock uwsRes.end to prevent response completion, call send() to mark
        // headers as sent, then restore end and throw to simulate late error
        const originalEnd = res.uwsRes.end;
        res.uwsRes.end = jest.fn();

        // This will call writeHead() internally, marking headers as sent
        res.send({ partial: 'data' });

        // Restore end and throw error
        res.uwsRes.end = originalEnd;
        throw new Error('Handler error');
      });

      registryWithLogger.register('GET', '/error', handler);

      const uwsHandler = registeredRoutes.get('GET:/error')?.handler;
      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();

      await uwsHandler!(mockUwsRes, mockUwsReq);

      // Error should be logged
      expect(loggerErrorSpy).toHaveBeenCalledWith('Unhandled route error:', expect.any(Error));

      // Should NOT attempt to send error response when headers already sent
      // (writeStatus would have been called once by send(), not again for error)
      expect(mockUwsRes.writeStatus).toHaveBeenCalledTimes(1);
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('200 OK');
    });
  });

  describe('route matching order', () => {
    it('should match routes in registration order within same wildcard prefix', async () => {
      const handler1 = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'first' });
      });
      const handler2 = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'second' });
      });

      // Register two routes with same static prefix /api/users
      // Both have optional params so they share the wildcard
      registry.register('GET', '/api/users/:id?', handler1);
      registry.register('GET', '/api/users/:name?', handler2);

      // Get the wildcard handler for /api/users/*
      const uwsHandler = registeredRoutes.get('GET:/api/users/*')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/api/users/123');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      // First handler should be called (registration order)
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should demonstrate importance of registration order with wildcards', async () => {
      const specificHandler = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'specific' });
      });
      const wildcardHandler = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'wildcard' });
      });

      // Register wildcard BEFORE specific route (bad practice)
      // Both share /api/* prefix
      registry.register('GET', '/api/*', wildcardHandler);
      registry.register('GET', '/api/users/:id', specificHandler);

      const uwsHandler = registeredRoutes.get('GET:/api/*')?.handler;
      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/api/users/123');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      // Wildcard handler matches first (even though specific route exists)
      expect(wildcardHandler).toHaveBeenCalled();
      expect(specificHandler).not.toHaveBeenCalled();
    });

    it('should match optional parameter routes in registration order', async () => {
      const handler1 = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'first' });
      });
      const handler2 = jest.fn(async (_req, res) => {
        res.status(200).send({ handler: 'second' });
      });

      // Both routes have optional params and share /users/* prefix
      registry.register('GET', '/users/:id?', handler1);
      registry.register('GET', '/users/:name?/:action?', handler2);

      const uwsHandler = registeredRoutes.get('GET:/users/*')?.handler;
      expect(uwsHandler).toBeDefined();

      // Test with /users/123 - both could match
      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/users/123');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      // First handler should match (registration order)
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should match bare path when route has optional parameters', async () => {
      const handler = jest.fn(async (req, res) => {
        res.status(200).send({ id: req.params.id || 'none' });
      });

      // Register route with optional parameter
      registry.register('GET', '/users/:id?', handler);

      // Verify both wildcard and bare routes are registered
      expect(mockUwsApp.get).toHaveBeenCalledWith('/users/*', expect.any(Function));
      expect(mockUwsApp.get).toHaveBeenCalledWith('/users', expect.any(Function));

      const uwsHandler = registeredRoutes.get('GET:/users/*')?.handler;
      expect(uwsHandler).toBeDefined();

      // Test with bare path /users (no trailing segment)
      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/users');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      // Handler should be called with empty params
      expect(handler).toHaveBeenCalled();
      const req = handler.mock.calls[0][0];
      expect(req.params.id).toBeUndefined();
    });
  });

  describe('regex metacharacter escaping', () => {
    it('should handle paths with dots', async () => {
      const handler = jest.fn(async (_req, res) => {
        res.status(200).send({ ok: true });
      });

      registry.register('GET', '/files/image.png', handler);

      const uwsHandler = registeredRoutes.get('GET:/files/image.png')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/files/image.png');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      expect(handler).toHaveBeenCalled();
    });

    it('should handle paths with plus signs', async () => {
      const handler = jest.fn(async (_req, res) => {
        res.status(200).send({ ok: true });
      });

      registry.register('GET', '/api/v1+beta/:id?', handler);

      const uwsHandler = registeredRoutes.get('GET:/api/v1+beta/*')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/api/v1+beta/123');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      expect(handler).toHaveBeenCalled();
    });

    it('should handle paths with dollar signs', async () => {
      const handler = jest.fn(async (_req, res) => {
        res.status(200).send({ ok: true });
      });

      registry.register('GET', '/price/$100/:id?', handler);

      const uwsHandler = registeredRoutes.get('GET:/price/$100/*')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/price/$100/item1');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      expect(handler).toHaveBeenCalled();
    });

    it('should handle paths with brackets', async () => {
      const handler = jest.fn(async (_req, res) => {
        res.status(200).send({ ok: true });
      });

      registry.register('GET', '/api/[v1]/:id?', handler);

      const uwsHandler = registeredRoutes.get('GET:/api/[v1]/*')?.handler;
      expect(uwsHandler).toBeDefined();

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      (mockUwsReq.getUrl as jest.Mock).mockReturnValue('/api/[v1]/123');

      await uwsHandler!(mockUwsRes, mockUwsReq);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('registerCorsHandler', () => {
    it('should register CORS handler successfully', () => {
      const mockCorsHandler = {
        handle: jest.fn(),
      } as any;

      expect(() => registry.registerCorsHandler(mockCorsHandler)).not.toThrow();
    });

    it('should throw error when handler is null', () => {
      expect(() => registry.registerCorsHandler(null as any)).toThrow(
        'CORS handler cannot be null or undefined'
      );
    });

    it('should throw error when handler is undefined', () => {
      expect(() => registry.registerCorsHandler(undefined as any)).toThrow(
        'CORS handler cannot be null or undefined'
      );
    });

    it('should throw error when handler does not have handle method', () => {
      const invalidHandler = {} as any;
      expect(() => registry.registerCorsHandler(invalidHandler)).toThrow(
        'CORS handler must have a handle method'
      );
    });

    it('should warn when replacing existing CORS handler', () => {
      const warnSpy = jest.fn();
      const mockLogger = {
        error: jest.fn(),
        warn: warnSpy,
      };
      const registryWithLogger = new RouteRegistry(mockUwsApp, {
        maxBodySize: 1024 * 1024,
        logger: mockLogger,
      });

      const mockCorsHandler1 = {
        handle: jest.fn(),
      } as any;
      const mockCorsHandler2 = {
        handle: jest.fn(),
      } as any;

      registryWithLogger.registerCorsHandler(mockCorsHandler1);
      registryWithLogger.registerCorsHandler(mockCorsHandler2);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('CORS handler is being replaced')
      );
    });

    it('should register OPTIONS catch-all route for preflight requests', () => {
      const mockCorsHandler = {
        handle: jest.fn(),
      } as any;

      registry.registerCorsHandler(mockCorsHandler);

      // Verify OPTIONS route was registered
      expect(mockUwsApp.options).toHaveBeenCalledWith('/*', expect.any(Function));
    });

    it('should handle CORS for unmatched preflight requests', async () => {
      const mockCorsHandler = {
        handle: jest.fn().mockResolvedValue(true), // Preflight handled
      } as any;

      registry.registerCorsHandler(mockCorsHandler);

      // Get the OPTIONS handler that was registered
      const optionsHandler = (mockUwsApp.options as jest.Mock).mock.calls[0][1];

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      mockUwsReq.getMethod = jest.fn().mockReturnValue('options');
      mockUwsReq.getUrl = jest.fn().mockReturnValue('/unregistered-path');

      await optionsHandler(mockUwsRes, mockUwsReq);

      // CORS handler should have been called
      expect(mockCorsHandler.handle).toHaveBeenCalled();

      // 404 should NOT be sent since CORS handled it
      expect(mockUwsRes.writeStatus).not.toHaveBeenCalledWith('404 Not Found');
    });

    it('should send 404 for unmatched preflight when CORS rejects', async () => {
      const mockCorsHandler = {
        handle: jest.fn().mockResolvedValue(false), // CORS did not handle (e.g., origin rejected)
      } as any;

      registry.registerCorsHandler(mockCorsHandler);

      // Get the OPTIONS handler that was registered
      const optionsHandler = (mockUwsApp.options as jest.Mock).mock.calls[0][1];

      const { mockUwsRes, mockUwsReq } = createMockUwsReqRes();
      mockUwsReq.getMethod = jest.fn().mockReturnValue('options');
      mockUwsReq.getUrl = jest.fn().mockReturnValue('/unregistered-path');

      await optionsHandler(mockUwsRes, mockUwsReq);

      // CORS handler should have been called
      expect(mockCorsHandler.handle).toHaveBeenCalled();

      // 404 should be sent since CORS didn't handle it
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('404 Not Found');
    });
  });
});
