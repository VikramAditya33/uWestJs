import * as uWS from 'uWebSockets.js';
import { UwsPlatformAdapter } from './uws-platform.adapter';
import { UwsAdapter } from '../adapter/uws.adapter';
import { RouteRegistry } from './route-registry';

// Mock uWebSockets.js
jest.mock('uWebSockets.js', () => ({
  App: jest.fn(() => mockUwsApp),
  SSLApp: jest.fn(() => mockUwsApp),
  us_listen_socket_close: jest.fn(),
  SHARED_COMPRESSOR: 0,
}));

// Mock dependencies
jest.mock('../adapter/uws.adapter');
jest.mock('./route-registry');

let mockUwsApp: any;
let mockListenSocket: any;

describe('UwsPlatformAdapter', () => {
  beforeEach(() => {
    mockListenSocket = { mock: 'socket' };

    mockUwsApp = {
      listen: jest.fn((_host, _port, callback) => {
        callback(mockListenSocket);
      }),
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      del: jest.fn(),
      patch: jest.fn(),
      options: jest.fn(),
      head: jest.fn(),
      any: jest.fn(),
    };

    // Reset mocks
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create uWS App with default options', () => {
      new UwsPlatformAdapter();

      expect(uWS.App).toHaveBeenCalled();
    });

    it('should validate maxBodySize - reject negative values', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: -1 })).toThrow(
        'Invalid maxBodySize: -1. Must be a positive integer'
      );
    });

    it('should validate maxBodySize - reject zero', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: 0 })).toThrow(
        'Invalid maxBodySize: 0. Must be a positive integer'
      );
    });

    it('should validate maxBodySize - reject Infinity', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: Infinity })).toThrow(
        'Invalid maxBodySize: Infinity. Must be a positive integer'
      );
    });

    it('should validate maxBodySize - reject NaN', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: NaN })).toThrow(
        'Invalid maxBodySize: NaN. Must be a positive integer'
      );
    });

    it('should validate maxBodySize - reject non-integers', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: 1024.5 })).toThrow(
        'Invalid maxBodySize: 1024.5. Must be a positive integer'
      );
    });

    it('should validate maxBodySize - reject non-numbers', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: '1024' as any })).toThrow(
        'Invalid maxBodySize: 1024. Must be a positive integer'
      );
    });

    it('should accept valid maxBodySize', () => {
      expect(() => new UwsPlatformAdapter({ maxBodySize: 1024 })).not.toThrow();
      expect(() => new UwsPlatformAdapter({ maxBodySize: 10 * 1024 * 1024 })).not.toThrow();
    });

    it('should create uWS SSLApp when SSL options provided', () => {
      new UwsPlatformAdapter({
        key_file_name: '/path/to/key.pem',
        cert_file_name: '/path/to/cert.pem',
      } as any);

      expect(uWS.SSLApp).toHaveBeenCalledWith({
        key_file_name: '/path/to/key.pem',
        cert_file_name: '/path/to/cert.pem',
        passphrase: undefined,
        dh_params_file_name: undefined,
        ssl_prefer_low_memory_usage: undefined,
      });
    });

    it('should throw error when only key_file_name is provided', () => {
      expect(() => {
        new UwsPlatformAdapter({
          key_file_name: '/path/to/key.pem',
        } as any);
      }).toThrow(
        'SSL configuration incomplete: both key_file_name and cert_file_name must be provided together'
      );
    });

    it('should throw error when only cert_file_name is provided', () => {
      expect(() => {
        new UwsPlatformAdapter({
          cert_file_name: '/path/to/cert.pem',
        } as any);
      }).toThrow(
        'SSL configuration incomplete: both key_file_name and cert_file_name must be provided together'
      );
    });

    it('should merge user options with defaults', () => {
      const adapter = new UwsPlatformAdapter({
        maxBodySize: 5 * 1024 * 1024,
        port: 3000,
      });

      expect(adapter).toBeInstanceOf(UwsPlatformAdapter);
    });

    it('should create RouteRegistry', () => {
      new UwsPlatformAdapter();

      expect(RouteRegistry).toHaveBeenCalledWith(mockUwsApp, expect.any(Object));
    });
  });

  describe('listen', () => {
    it('should listen on specified port with default hostname', () => {
      const adapter = new UwsPlatformAdapter();
      const callback = jest.fn();

      adapter.listen(3000, callback);

      expect(mockUwsApp.listen).toHaveBeenCalledWith('0.0.0.0', 3000, expect.any(Function));
      expect(callback).toHaveBeenCalled();
    });

    it('should listen on specified port and hostname', () => {
      const adapter = new UwsPlatformAdapter();
      const callback = jest.fn();

      adapter.listen(3000, 'localhost', callback);

      expect(mockUwsApp.listen).toHaveBeenCalledWith('localhost', 3000, expect.any(Function));
      expect(callback).toHaveBeenCalled();
    });

    it('should throw error if listen fails', (done) => {
      mockUwsApp.listen = jest.fn((_host, _port, callback) => {
        callback(false); // Simulate failure
      });

      const adapter = new UwsPlatformAdapter();

      // Pass callback to capture error (Node.js convention)
      adapter.listen(3000, (error?: Error) => {
        expect(error).toBeDefined();
        expect(error?.message).toBe('Failed to listen on 0.0.0.0:3000');
        done();
      });
    });

    it('should throw error asynchronously if listen fails without callback', async () => {
      mockUwsApp.listen = jest.fn((_host, _port, callback) => {
        callback(false); // Simulate failure
      });

      const adapter = new UwsPlatformAdapter();

      // Wrap in promise to catch async error thrown via process.nextTick
      await expect(
        new Promise((resolve, reject) => {
          const nextTickSpy = jest.spyOn(process, 'nextTick').mockImplementation((fn: any) => {
            nextTickSpy.mockRestore();
            try {
              fn();
              resolve(undefined);
            } catch (error) {
              reject(error);
            }
          });

          // No callback provided - should throw asynchronously
          adapter.listen(3000);
        })
      ).rejects.toThrow('Failed to listen on 0.0.0.0:3000');
    });
  });

  describe('close', () => {
    it('should close listen socket', async () => {
      const adapter = new UwsPlatformAdapter();
      adapter.listen(3000);

      await adapter.close();

      expect(uWS.us_listen_socket_close).toHaveBeenCalledWith(mockListenSocket);
    });

    it('should resolve even if no socket exists', async () => {
      const adapter = new UwsPlatformAdapter();

      await expect(adapter.close()).resolves.toBeUndefined();
    });

    it('should close WebSocket adapter if initialized', async () => {
      const adapter = new UwsPlatformAdapter();
      adapter.listen(3000);

      // Initialize WebSocket adapter
      const wsAdapter = adapter.initWebSocketAdapter(null);
      const closeSpy = jest.spyOn(wsAdapter, 'close');

      await adapter.close();

      // Should close HTTP socket
      expect(uWS.us_listen_socket_close).toHaveBeenCalledWith(mockListenSocket);
      // Should close WebSocket adapter (closes all connections and clears resources)
      expect(closeSpy).toHaveBeenCalledWith(null);
    });

    it('should not fail if WebSocket adapter not initialized', async () => {
      const adapter = new UwsPlatformAdapter();
      adapter.listen(3000);

      // Don't initialize WebSocket adapter
      await expect(adapter.close()).resolves.toBeUndefined();

      expect(uWS.us_listen_socket_close).toHaveBeenCalledWith(mockListenSocket);
    });
  });

  describe('getHttpServer', () => {
    it('should return uWS App instance', () => {
      const adapter = new UwsPlatformAdapter();

      expect(adapter.getHttpServer()).toBe(mockUwsApp);
    });
  });

  describe('getInstance', () => {
    it('should return uWS App instance', () => {
      const adapter = new UwsPlatformAdapter();

      expect(adapter.getInstance()).toBe(mockUwsApp);
    });
  });

  describe('getType', () => {
    it('should return "uws"', () => {
      const adapter = new UwsPlatformAdapter();

      expect(adapter.getType()).toBe('uws');
    });
  });

  describe('HTTP method registration', () => {
    let adapter: UwsPlatformAdapter;
    let mockRegistry: any;

    beforeEach(() => {
      mockRegistry = {
        register: jest.fn(),
      };
      (RouteRegistry as jest.Mock).mockImplementation(() => mockRegistry);

      adapter = new UwsPlatformAdapter();
    });

    // Test all HTTP methods with data-driven approach
    const methodTests = [
      { method: 'get', registryMethod: 'GET', path: '/users' },
      { method: 'post', registryMethod: 'POST', path: '/users' },
      { method: 'put', registryMethod: 'PUT', path: '/users/:id' },
      { method: 'delete', registryMethod: 'DELETE', path: '/users/:id' },
      { method: 'patch', registryMethod: 'PATCH', path: '/users/:id' },
      { method: 'options', registryMethod: 'OPTIONS', path: '/users' },
      { method: 'head', registryMethod: 'HEAD', path: '/users' },
      { method: 'all', registryMethod: 'ALL', path: '/users' },
    ];

    methodTests.forEach(({ method, registryMethod, path }) => {
      it(`should register ${method.toUpperCase()} route`, () => {
        const handler = jest.fn();
        (adapter as any)[method](path, handler);

        expect(mockRegistry.register).toHaveBeenCalledWith(registryMethod, path, handler);
      });
    });
  });

  describe('WebSocket adapter integration', () => {
    it('should initialize WebSocket adapter with shared uWS instance', () => {
      const adapter = new UwsPlatformAdapter();
      const httpServer = {};

      const wsAdapter = adapter.initWebSocketAdapter(httpServer);

      expect(UwsAdapter).toHaveBeenCalledWith(
        httpServer,
        expect.objectContaining({
          uwsApp: mockUwsApp,
        })
      );
      expect(wsAdapter).toBeInstanceOf(UwsAdapter);
    });

    it('should return same WebSocket adapter on multiple calls', () => {
      const adapter = new UwsPlatformAdapter();
      const httpServer = {};

      const wsAdapter1 = adapter.initWebSocketAdapter(httpServer);
      const wsAdapter2 = adapter.initWebSocketAdapter(httpServer);

      expect(wsAdapter1).toBe(wsAdapter2);
      expect(UwsAdapter).toHaveBeenCalledTimes(1);
    });

    it('should return WebSocket adapter via getter', () => {
      const adapter = new UwsPlatformAdapter();
      const httpServer = {};

      adapter.initWebSocketAdapter(httpServer);
      const wsAdapter = adapter.getWebSocketAdapter();

      expect(wsAdapter).toBeInstanceOf(UwsAdapter);
    });

    it('should return undefined if WebSocket adapter not initialized', () => {
      const adapter = new UwsPlatformAdapter();

      expect(adapter.getWebSocketAdapter()).toBeUndefined();
    });
  });

  describe('response helpers', () => {
    let adapter: UwsPlatformAdapter;
    let mockResponse: any;

    beforeEach(() => {
      adapter = new UwsPlatformAdapter();
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        setHeader: jest.fn(),
        getHeader: jest.fn(),
      };
    });

    it('should reply with body and status code', () => {
      adapter.reply(mockResponse, { data: 'test' }, 200);

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.send).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should reply with body only', () => {
      adapter.reply(mockResponse, { data: 'test' });

      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.send).toHaveBeenCalledWith({ data: 'test' });
    });

    it('should set status code', () => {
      adapter.status(mockResponse, 404);

      expect(mockResponse.status).toHaveBeenCalledWith(404);
    });

    it('should redirect', () => {
      adapter.redirect(mockResponse, 302, 'https://example.com');

      expect(mockResponse.status).toHaveBeenCalledWith(302);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Location', 'https://example.com');
      expect(mockResponse.send).toHaveBeenCalled();
    });

    it('should set header', () => {
      adapter.setHeader(mockResponse, 'X-Custom', 'value');

      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Custom', 'value');
    });

    it('should append header', () => {
      mockResponse.getHeader.mockReturnValue('value1');

      adapter.appendHeader(mockResponse, 'X-Custom', 'value2');

      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Custom', ['value1', 'value2']);
    });

    it('should append header when none exists', () => {
      mockResponse.getHeader.mockReturnValue(undefined);

      adapter.appendHeader(mockResponse, 'X-Custom', 'value');

      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-Custom', 'value');
    });

    it('should end response', () => {
      adapter.end(mockResponse, 'Done');

      expect(mockResponse.send).toHaveBeenCalledWith('Done');
    });

    it('should get header', () => {
      mockResponse.getHeader.mockReturnValue('value');

      const result = adapter.getHeader(mockResponse, 'X-Custom');

      expect(result).toBe('value');
    });
  });

  describe('request helpers', () => {
    let adapter: UwsPlatformAdapter;
    let mockRequest: any;

    beforeEach(() => {
      adapter = new UwsPlatformAdapter();
      mockRequest = {
        method: 'GET',
        originalUrl: '/users?page=1',
        get: jest.fn(),
      };
    });

    it('should get request hostname', () => {
      mockRequest.get.mockReturnValue('example.com');

      const hostname = adapter.getRequestHostname(mockRequest);

      expect(hostname).toBe('example.com');
      expect(mockRequest.get).toHaveBeenCalledWith('host');
    });

    it('should handle array host header', () => {
      mockRequest.get.mockReturnValue(['example.com', 'www.example.com']);

      const hostname = adapter.getRequestHostname(mockRequest);

      expect(hostname).toBe('example.com');
    });

    it('should return empty string if no host', () => {
      mockRequest.get.mockReturnValue(undefined);

      const hostname = adapter.getRequestHostname(mockRequest);

      expect(hostname).toBe('');
    });

    it('should get request method', () => {
      const method = adapter.getRequestMethod(mockRequest);

      expect(method).toBe('GET');
    });

    it('should get request URL', () => {
      const url = adapter.getRequestUrl(mockRequest);

      expect(url).toBe('/users?page=1');
    });

    it('should check if headers sent', () => {
      const mockResponse = { headersSent: true } as any;

      const result = adapter.isHeadersSent(mockResponse);

      expect(result).toBe(true);
    });
  });

  describe('not implemented methods', () => {
    let adapter: UwsPlatformAdapter;

    beforeEach(() => {
      adapter = new UwsPlatformAdapter();
    });

    it('should throw error for render', () => {
      expect(() => {
        adapter.render({} as any, 'view', {});
      }).toThrow('render() not implemented');
    });

    it('should throw error for use (middleware)', () => {
      expect(() => {
        adapter.use(jest.fn());
      }).toThrow('UwsPlatformAdapter does not support Express-style middleware');
    });

    it('should throw error for useStaticAssets', () => {
      expect(() => {
        adapter.useStaticAssets('/public');
      }).toThrow('UwsPlatformAdapter does not support static file serving yet');
    });

    it('should not throw for setViewEngine', () => {
      expect(() => {
        adapter.setViewEngine('ejs');
      }).not.toThrow();
    });

    it('should not throw for registerParserMiddleware', () => {
      expect(() => {
        adapter.registerParserMiddleware();
      }).not.toThrow();
    });
  });

  describe('getRouteRegistry', () => {
    it('should return route registry instance', () => {
      const mockRegistry = { mock: 'registry' };
      (RouteRegistry as jest.Mock).mockImplementation(() => mockRegistry);

      const adapter = new UwsPlatformAdapter();
      const registry = adapter.getRouteRegistry();

      expect(registry).toBe(mockRegistry);
    });
  });
});
