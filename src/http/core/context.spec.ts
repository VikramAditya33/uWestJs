import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { HttpExecutionContext } from './context';
import { UwsRequest } from './request';
import { UwsResponse } from './response';
import { createMockUwsRequest, createMockUwsResponse } from '../test-helpers';

describe('HttpExecutionContext', () => {
  let mockUwsReq: jest.Mocked<HttpRequest>;
  let mockUwsRes: jest.Mocked<HttpResponse>;
  let request: UwsRequest;
  let response: UwsResponse;
  let handler: jest.Mock;
  let classRef: any;
  let context: HttpExecutionContext;

  beforeEach(() => {
    // Create mock uWS request
    mockUwsReq = createMockUwsRequest();

    // Create mock uWS response
    const { mockRes } = createMockUwsResponse();
    mockUwsRes = mockRes;

    // Create request and response instances
    request = new UwsRequest(mockUwsReq, mockUwsRes);
    response = new UwsResponse(mockUwsRes);

    // Create mock handler and class
    handler = jest.fn();
    classRef = class TestController {};

    // Create execution context
    context = new HttpExecutionContext(request, response, handler, classRef);
  });

  describe('getClass()', () => {
    it('should return the controller class', () => {
      expect(context.getClass()).toBe(classRef);
    });
  });

  describe('getHandler()', () => {
    it('should return the handler function', () => {
      expect(context.getHandler()).toBe(handler);
    });
  });

  describe('getArgs()', () => {
    it('should return array with request and response', () => {
      const args = context.getArgs();

      expect(args).toHaveLength(2);
      expect(args[0]).toBe(request);
      expect(args[1]).toBe(response);
    });
  });

  describe('getArgByIndex()', () => {
    it('should return request at index 0', () => {
      expect(context.getArgByIndex(0)).toBe(request);
    });

    it('should return response at index 1', () => {
      expect(context.getArgByIndex(1)).toBe(response);
    });

    it('should return undefined for out of bounds index', () => {
      expect(context.getArgByIndex(2)).toBeUndefined();
    });

    it('should return undefined for negative index', () => {
      expect(context.getArgByIndex(-1)).toBeUndefined();
    });
  });

  describe('getType()', () => {
    it('should return "http"', () => {
      expect(context.getType()).toBe('http');
    });
  });

  describe('switchToHttp()', () => {
    it('should return HTTP context object with all methods', () => {
      const httpContext = context.switchToHttp();

      expect(httpContext).toHaveProperty('getRequest');
      expect(httpContext).toHaveProperty('getResponse');
      expect(httpContext).toHaveProperty('getNext');
      expect(httpContext.getRequest()).toBe(request);
      expect(httpContext.getResponse()).toBe(response);
    });

    it('should return no-op function via getNext()', () => {
      const next = context.switchToHttp().getNext();

      expect(typeof next).toBe('function');
      expect(next()).toBeUndefined();
    });

    it('should return same instances on multiple calls', () => {
      const httpContext1 = context.switchToHttp();
      const httpContext2 = context.switchToHttp();

      expect(httpContext1.getRequest()).toBe(httpContext2.getRequest());
      expect(httpContext1.getResponse()).toBe(httpContext2.getResponse());
    });
  });

  describe('switchToRpc()', () => {
    it('should throw error', () => {
      expect(() => context.switchToRpc()).toThrow(
        'RPC context not supported in HTTP execution context'
      );
    });
  });

  describe('switchToWs()', () => {
    it('should throw error', () => {
      expect(() => context.switchToWs()).toThrow(
        'WebSocket context not supported in HTTP execution context'
      );
    });
  });

  describe('NestJS integration patterns', () => {
    it('should work with guard pattern accessing request', () => {
      // Explicitly configure mock with expected values
      const mockReq = createMockUwsRequest({
        method: 'GET',
        url: '/test',
      });
      const { mockRes } = createMockUwsResponse();
      const req = new UwsRequest(mockReq, mockRes);
      const res = new UwsResponse(mockRes);
      const testContext = new HttpExecutionContext(req, res, handler, classRef);

      const contextReq = testContext.switchToHttp().getRequest();

      expect(contextReq.method).toBe('GET');
      expect(contextReq.url).toBe('/test');
    });

    it('should work with interceptor pattern accessing metadata', () => {
      expect(context.getHandler()).toBe(handler);
      expect(context.getClass()).toBe(classRef);
    });

    it('should work with pipe pattern accessing arguments', () => {
      const [req, res] = context.getArgs();

      expect(req).toBeInstanceOf(UwsRequest);
      expect(res).toBeInstanceOf(UwsResponse);
    });

    it('should work with exception filter pattern sending error response', () => {
      const res = context.switchToHttp().getResponse();

      res.status(500).send({ error: 'Internal Server Error' });

      expect(mockUwsRes.writeStatus).toHaveBeenCalledWith('500 Internal Server Error');
      expect(mockUwsRes.end).toHaveBeenCalledWith(
        JSON.stringify({ error: 'Internal Server Error' })
      );
    });
  });

  describe('type checking', () => {
    it('should allow type-based routing in guards', () => {
      expect(context.getType()).toBe('http');
      expect(context.switchToHttp().getRequest()).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle null handler and classRef', () => {
      const contextWithNulls = new HttpExecutionContext(
        request,
        response,
        null as any,
        null as any
      );

      expect(contextWithNulls.getHandler()).toBeNull();
      expect(() => contextWithNulls.getClass()).toThrow(
        'Controller class reference is not available'
      );
    });
  });
});
