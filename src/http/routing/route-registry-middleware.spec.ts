import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js';
import { RouteRegistry, RouteMetadata } from './route-registry';
import type { CanActivate, PipeTransform, ExceptionFilter } from '@nestjs/common';
import {
  createMockUwsRequest,
  createMockUwsResponse,
  createMockUwsApp,
  toArrayBuffer,
  type UwsRouteHandler,
} from '../test-helpers';
import { UwsRequest } from '../core/request';
import { of } from 'rxjs';

describe('RouteRegistry - Middleware Integration', () => {
  let mockUwsApp: TemplatedApp;
  let registry: RouteRegistry;
  let mockUwsReq: jest.Mocked<HttpRequest>;
  let mockUwsRes: jest.Mocked<HttpResponse>;
  let registeredRoutes: Map<string, { path: string; handler: UwsRouteHandler }>;

  beforeEach(() => {
    // Create mock uWS app with route tracking
    const { mockApp, registeredRoutes: routes } = createMockUwsApp({ trackRoutes: true });
    mockUwsApp = mockApp;
    registeredRoutes = routes;

    // Create mock uWS request
    mockUwsReq = createMockUwsRequest({
      method: 'get',
      url: '/test',
    });

    // Create mock uWS response
    const { mockRes } = createMockUwsResponse();
    mockUwsRes = mockRes;

    registry = new RouteRegistry(mockUwsApp, { maxBodySize: 1024 * 1024 });
  });

  describe('guards', () => {
    it('should execute guards before handler', async () => {
      const executionOrder: string[] = [];

      class TestGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard');
          return true;
        }
      }

      const handler = jest.fn(() => {
        executionOrder.push('handler');
      });
      registry.register('GET', '/protected', handler, { guards: [TestGuard] });

      const registeredHandler = registeredRoutes.get('GET:/protected')?.handler;
      expect(registeredHandler).toBeDefined();
      await registeredHandler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['guard', 'handler']);
    });

    it('should deny access when guard returns false', async () => {
      class DenyGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          return false;
        }
      }

      const handler = jest.fn();
      registry.register('GET', '/protected', handler, { guards: [DenyGuard] });

      await registeredRoutes.get('GET:/protected')?.handler!(mockUwsRes, mockUwsReq);

      expect(handler).not.toHaveBeenCalled();
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('403 Forbidden');
    });

    it('should execute multiple guards in order', async () => {
      const executionOrder: string[] = [];

      class Guard1 implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard1');
          return true;
        }
      }

      class Guard2 implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard2');
          return true;
        }
      }

      const handler = jest.fn(() => {
        executionOrder.push('handler');
      });
      registry.register('GET', '/test', handler, { guards: [Guard1, Guard2] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['guard1', 'guard2', 'handler']);
    });

    it('should stop execution when first guard fails', async () => {
      const executionOrder: string[] = [];

      class Guard1 implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard1');
          return false;
        }
      }

      class Guard2 implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard2');
          return true;
        }
      }

      const handler = jest.fn(() => {
        executionOrder.push('handler');
      });
      registry.register('GET', '/test', handler, { guards: [Guard1, Guard2] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['guard1']);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle guards returning Observables', async () => {
      class ObservableGuard implements CanActivate {
        canActivate() {
          return of(true);
        }
      }

      const handler = jest.fn();
      registry.register('GET', '/test', handler, { guards: [ObservableGuard] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(handler).toHaveBeenCalled();
    });

    it('should propagate guard exceptions to exception filters', async () => {
      // Custom exception that mimics NestJS HttpException
      class UnauthorizedException extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'UnauthorizedException';
        }
        getStatus() {
          return 401;
        }
      }

      class ThrowingGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          throw new UnauthorizedException('Invalid token');
        }
      }

      class CustomExceptionFilter implements ExceptionFilter {
        async catch(exception: any, host: any): Promise<void> {
          const response = host.switchToHttp().getResponse();
          const status = exception.getStatus?.() || 500;
          response.status(status).send({
            statusCode: status,
            message: exception.message,
          });
        }
      }

      const handler = jest.fn();
      registry.register('GET', '/test', handler, {
        guards: [ThrowingGuard],
        filters: [CustomExceptionFilter],
      });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      // Handler should not be called
      expect(handler).not.toHaveBeenCalled();

      // Exception filter should preserve the 401 status (not 403)
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('401 Unauthorized');
    });
  });

  describe('pipes', () => {
    it('should execute pipes on request body', async () => {
      class UpperCasePipe implements PipeTransform {
        async transform(value: any): Promise<any> {
          return typeof value === 'string' ? value.toUpperCase() : value;
        }
      }

      const handler = jest.fn(async (req: UwsRequest) => {
        const body = await req.body;
        expect(body).toBe('HELLO');
      });

      // Mock content-type header and content-length
      mockUwsReq.forEach = jest.fn((callback) => {
        callback('content-type', 'text/plain');
        callback('content-length', '5');
      });

      // Create response with callback tracking
      const { mockRes, callbacks } = createMockUwsResponse();
      mockUwsRes = mockRes;

      registry.register('POST', '/test', handler, { pipes: [UpperCasePipe] });

      // Start the handler (which will register onData callback)
      const handlerPromise = registeredRoutes.get('POST:/test')?.handler!(mockUwsRes, mockUwsReq);

      // Wait for the onData callback to be registered
      await new Promise((resolve) => setImmediate(resolve));

      // Simulate body data being received
      const bodyData = 'hello';
      const arrayBuffer = toArrayBuffer(Buffer.from(bodyData));

      // Send the body data
      callbacks.onData!(arrayBuffer, true);

      // Wait for handler to complete
      await handlerPromise;

      expect(handler).toHaveBeenCalled();
    });

    it('should make transformed body accessible via req.body', async () => {
      class MultiplyPipe implements PipeTransform {
        async transform(value: any): Promise<any> {
          if (typeof value === 'object' && value !== null && 'number' in value) {
            return { number: value.number * 2 };
          }
          return value;
        }
      }

      let capturedBody: any;
      const handler = jest.fn(async (req) => {
        capturedBody = await req.body;
      });

      // Mock content-type header and content-length
      mockUwsReq.forEach = jest.fn((callback) => {
        callback('content-type', 'application/json');
        callback('content-length', '13');
      });

      // Create response with callback tracking
      const { mockRes, callbacks } = createMockUwsResponse();
      mockUwsRes = mockRes;

      registry.register('POST', '/test', handler, { pipes: [MultiplyPipe] });

      // Start the handler (which will register onData callback)
      const handlerPromise = registeredRoutes.get('POST:/test')?.handler!(mockUwsRes, mockUwsReq);

      // Wait a tick for the onData callback to be registered
      await new Promise((resolve) => setImmediate(resolve));

      // Simulate body data being received
      const bodyData = JSON.stringify({ number: 5 });
      const arrayBuffer = toArrayBuffer(Buffer.from(bodyData));

      // Send the body data
      callbacks.onData!(arrayBuffer, true);

      // Wait for handler to complete
      await handlerPromise;

      expect(handler).toHaveBeenCalled();
      expect(capturedBody).toEqual({ number: 10 });
    });

    it('should execute multiple pipes in order', async () => {
      const executionOrder: string[] = [];

      class Pipe1 implements PipeTransform {
        async transform(value: any): Promise<any> {
          executionOrder.push('pipe1');
          return value;
        }
      }

      class Pipe2 implements PipeTransform {
        async transform(value: any): Promise<any> {
          executionOrder.push('pipe2');
          return value;
        }
      }

      const handler = jest.fn();

      // Prepare body data
      const bodyData = JSON.stringify({ test: 'data' });
      const bodyBuffer = Buffer.from(bodyData);

      // Mock content-type header and content-length to trigger body parsing
      mockUwsReq.forEach = jest.fn((callback) => {
        callback('content-type', 'application/json');
        callback('content-length', String(bodyBuffer.length));
      });

      // Create response with callback tracking
      const { mockRes, callbacks } = createMockUwsResponse();
      mockUwsRes = mockRes;

      registry.register('POST', '/test', handler, { pipes: [Pipe1, Pipe2] });

      // Start the handler (which will register onData callback)
      const handlerPromise = registeredRoutes.get('POST:/test')?.handler!(mockUwsRes, mockUwsReq);

      // Wait a tick for the onData callback to be registered
      await new Promise((resolve) => setImmediate(resolve));

      // Simulate body data being received
      const arrayBuffer = toArrayBuffer(bodyBuffer);

      // Send the body data
      callbacks.onData!(arrayBuffer, true);

      // Wait for handler to complete
      await handlerPromise;

      expect(executionOrder).toEqual(['pipe1', 'pipe2']);
    });

    it('should handle pipes returning Observables', async () => {
      class ObservablePipe implements PipeTransform {
        transform(value: any) {
          return of(typeof value === 'string' ? value.toUpperCase() : value);
        }
      }

      const handler = jest.fn(async (req: UwsRequest) => {
        const body = await req.body;
        expect(body).toBe('HELLO');
      });

      // Mock content-type and content-length headers
      mockUwsReq.forEach = jest.fn((callback) => {
        callback('content-type', 'text/plain');
        callback('content-length', '5');
      });

      // Create response with callback tracking
      const { mockRes, callbacks } = createMockUwsResponse();
      mockUwsRes = mockRes;

      registry.register('POST', '/test', handler, { pipes: [ObservablePipe] });

      const handlerPromise = registeredRoutes.get('POST:/test')?.handler!(mockUwsRes, mockUwsReq);

      // Wait for body parser to be set up
      await new Promise((resolve) => setImmediate(resolve));

      // Simulate body data
      const bodyData = 'hello';
      const arrayBuffer = toArrayBuffer(Buffer.from(bodyData));
      callbacks.onData!(arrayBuffer, true);

      await handlerPromise;

      expect(handler).toHaveBeenCalled();
    });

    it('should pass bodyMetadata to pipes for validation', async () => {
      // Mock DTO class
      class CreateUserDto {
        name!: string;
        age!: number;
      }

      let receivedMetadata: any;

      class MetadataCapturePipe implements PipeTransform {
        transform(value: any, metadata: any) {
          receivedMetadata = metadata;
          return value;
        }
      }

      const handler = jest.fn();

      // Mock content-type header and content-length
      mockUwsReq.forEach = jest.fn((callback) => {
        callback('content-type', 'application/json');
        callback('content-length', '27');
      });

      // Create response with callback tracking
      const { mockRes, callbacks } = createMockUwsResponse();
      mockUwsRes = mockRes;

      registry.register('POST', '/users', handler, {
        pipes: [MetadataCapturePipe],
        bodyMetadata: {
          type: 'body',
          metatype: CreateUserDto,
          data: undefined,
        },
      });

      // Start the handler
      const handlerPromise = registeredRoutes.get('POST:/users')?.handler!(mockUwsRes, mockUwsReq);

      // Wait for onData callback registration
      await new Promise((resolve) => setImmediate(resolve));

      // Simulate body data
      const bodyData = JSON.stringify({ name: 'John', age: 30 });
      const arrayBuffer = toArrayBuffer(Buffer.from(bodyData));

      callbacks.onData!(arrayBuffer, true);

      // Wait for handler to complete
      await handlerPromise;

      expect(handler).toHaveBeenCalled();
      expect(receivedMetadata).toEqual({
        type: 'body',
        metatype: CreateUserDto,
        data: undefined,
      });
    });
  });

  describe('exception filters', () => {
    it('should execute exception filters on errors', async () => {
      const filterExecuted = jest.fn();

      class TestFilter implements ExceptionFilter {
        async catch(exception: any, host: any): Promise<void> {
          filterExecuted(exception.message);
          const response = host.switchToHttp().getResponse();
          response.status(400).send({ error: exception.message });
        }
      }

      const handler = jest.fn(() => {
        throw new Error('Test error');
      });

      registry.register('GET', '/test', handler, { filters: [TestFilter] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(filterExecuted).toHaveBeenCalledWith('Test error');
      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('400 Bad Request');
    });

    it('should use default error handling when no filters provided', async () => {
      const handler = jest.fn(() => {
        throw new Error('Test error');
      });

      registry.register('GET', '/test', handler);

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('500 Internal Server Error');
    });

    it('should execute multiple exception filters', async () => {
      const executionOrder: string[] = [];

      class Filter1 implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('filter1');
        }
      }

      class Filter2 implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('filter2');
        }
      }

      const handler = jest.fn(() => {
        throw new Error('Test error');
      });

      registry.register('GET', '/test', handler, { filters: [Filter1, Filter2] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['filter1', 'filter2']);
    });

    it('should continue to next filter if one throws', async () => {
      const executionOrder: string[] = [];

      class Filter1 implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('filter1');
          throw new Error('Filter error');
        }
      }

      class Filter2 implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('filter2');
        }
      }

      const handler = jest.fn(() => {
        throw new Error('Test error');
      });

      registry.register('GET', '/test', handler, { filters: [Filter1, Filter2] });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['filter1', 'filter2']);
    });
  });

  describe('full middleware pipeline', () => {
    it('should handle errors with filters after guard/pipe execution', async () => {
      const executionOrder: string[] = [];

      class TestGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          executionOrder.push('guard');
          return true;
        }
      }

      class TestFilter implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('filter');
        }
      }

      const handler = jest.fn(() => {
        executionOrder.push('handler');
        throw new Error('Handler error');
      });

      registry.register('GET', '/test', handler, {
        guards: [TestGuard],
        filters: [TestFilter],
      });

      await registeredRoutes.get('GET:/test')?.handler!(mockUwsRes, mockUwsReq);

      expect(executionOrder).toEqual(['guard', 'handler', 'filter']);
    });
  });

  describe('metadata storage', () => {
    it('should store metadata with route', () => {
      class TestGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          return true;
        }
      }

      const handler = jest.fn();
      const metadata: RouteMetadata = {
        classRef: class TestController {},
        guards: [TestGuard],
      };

      registry.register('GET', '/test', handler, metadata);

      const route = registry.getRoutes().get('GET:/test');

      expect(route).toBeDefined();
      expect(route!.metadata).toBe(metadata);
      expect(route!.metadata!.guards).toEqual([TestGuard]);
    });

    it('should work without metadata', () => {
      const handler = jest.fn();

      registry.register('GET', '/test', handler);

      const route = registry.getRoutes().get('GET:/test');

      expect(route).toBeDefined();
      expect(route!.metadata).toBeUndefined();
    });
  });
});
