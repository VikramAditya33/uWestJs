/* eslint-disable no-undef */
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import * as uWS from 'uWebSockets.js';

/**
 * Shared test utilities for platform tests
 */

/**
 * Convert Buffer to ArrayBuffer (simulating uWS behavior)
 *
 * Uses Buffer's underlying ArrayBuffer with slice to create a proper copy.
 * This is more idiomatic than manually copying bytes via Uint8Array.
 *
 * Note: Buffer.buffer can be either ArrayBuffer or SharedArrayBuffer.
 * We cast to ArrayBuffer since slice() returns the same type and we're
 * only using this in tests where we control the Buffer creation.
 *
 * Used in tests to simulate uWebSockets.js ArrayBuffer chunks.
 */
export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

/**
 * Options for creating a mock uWS request
 */
export interface MockUwsRequestOptions {
  method?: string;
  url?: string;
  query?: string;
  headers?: Record<string, string>;
  params?: string[];
}

/**
 * Create a mock uWS HttpRequest for testing
 *
 * @param options - Configuration options for the mock request
 * @returns Mocked HttpRequest
 *
 * @example
 * ```typescript
 * const mockReq = createMockUwsRequest({
 *   method: 'POST',
 *   url: '/users/123',
 *   headers: { 'content-type': 'application/json' }
 * });
 * ```
 */
export function createMockUwsRequest(
  options: MockUwsRequestOptions = {}
): jest.Mocked<HttpRequest> {
  const {
    method = 'get',
    url = '/test',
    query = '',
    headers: rawHeaders = {},
    params = [],
  } = options;

  // Normalize header keys to lowercase to match uWS behavior
  // In real uWS, header names are always lowercase
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v])
  );

  return {
    getMethod: jest.fn(() => method),
    getUrl: jest.fn(() => url),
    getQuery: jest.fn(() => query),
    forEach: jest.fn((callback) => {
      Object.entries(headers).forEach(([key, value]) => callback(key, value));
    }),
    getParameter: jest.fn((index: number) => params[index] ?? ''),
    getHeader: jest.fn((name: string) => headers[name.toLowerCase()] ?? ''),
    setYield: jest.fn(),
  } as unknown as jest.Mocked<HttpRequest>;
}

/**
 * Options for creating a mock uWS response
 */
export interface MockUwsResponseOptions {
  /**
   * Whether write operations should succeed
   */
  writeSuccess?: boolean;
}

/**
 * Create a mock uWS HttpResponse for testing
 *
 * @param options - Configuration options for the mock response
 * @returns Mocked HttpResponse with callback references
 *
 * @example
 * ```typescript
 * const { mockRes, callbacks } = createMockUwsResponse();
 *
 * // Simulate connection abort
 * callbacks.onAborted?.();
 *
 * // Simulate data chunk
 * callbacks.onData?.(toArrayBuffer(Buffer.from('test')), false);
 * ```
 */
export function createMockUwsResponse(options: MockUwsResponseOptions = {}): {
  mockRes: jest.Mocked<HttpResponse>;
  callbacks: {
    onAborted: (() => void) | undefined;
    onData: ((chunk: ArrayBuffer, isLast: boolean) => void) | undefined;
    onWritable: ((offset: number) => boolean) | undefined;
  };
} {
  const { writeSuccess = true } = options;

  const callbacks: {
    onAborted: (() => void) | undefined;
    onData: ((chunk: ArrayBuffer, isLast: boolean) => void) | undefined;
    onWritable: ((offset: number) => boolean) | undefined;
  } = {
    onAborted: undefined,
    onData: undefined,
    onWritable: undefined,
  };

  const mockRes = {
    onAborted: jest.fn((callback) => {
      callbacks.onAborted = callback;
    }),
    onData: jest.fn((callback) => {
      callbacks.onData = callback;
    }),
    onWritable: jest.fn((callback) => {
      callbacks.onWritable = callback;
      return mockRes;
    }),
    cork: jest.fn((callback) => callback()),
    writeStatus: jest.fn().mockReturnThis(),
    writeHeader: jest.fn().mockReturnThis(),
    write: jest.fn(() => writeSuccess),
    end: jest.fn(),
    getWriteOffset: jest.fn(() => 0),
    tryEnd: jest.fn(() => [writeSuccess, false]),
    pause: jest.fn(),
    resume: jest.fn(),
    close: jest.fn(),
  } as unknown as jest.Mocked<HttpResponse>;

  return {
    mockRes,
    callbacks,
  };
}

/**
 * Route handler type for uWS
 */
export type RouteHandler = (res: HttpResponse, req: HttpRequest) => void | Promise<void>;

/**
 * Options for creating a mock uWS app
 */
export interface MockUwsAppOptions {
  /**
   * Whether listen should succeed
   */
  listenSuccess?: boolean;
  /**
   * Track registered routes
   */
  trackRoutes?: boolean;
}

/**
 * Create a mock uWS TemplatedApp for testing
 *
 * @param options - Configuration options for the mock app
 * @returns Mocked TemplatedApp with route tracking
 *
 * @example
 * ```typescript
 * const { mockApp, registeredRoutes } = createMockUwsApp({ trackRoutes: true });
 * mockApp.get('/test', handler);
 * const route = registeredRoutes.get('GET:/test');
 * expect(route.handler).toBeDefined();
 * ```
 */
export function createMockUwsApp(options: MockUwsAppOptions = {}): {
  mockApp: uWS.TemplatedApp;
  registeredRoutes: Map<string, { path: string; handler: RouteHandler }>;
  listenSocket: unknown;
} {
  const { listenSuccess = true, trackRoutes = false } = options;

  const registeredRoutes = new Map<string, { path: string; handler: RouteHandler }>();
  const listenSocket = listenSuccess ? { mock: 'socket' } : false;

  const createMethodMock = (method: string) => {
    return jest.fn((path: string, handler: RouteHandler) => {
      if (trackRoutes) {
        registeredRoutes.set(`${method}:${path}`, { path, handler });
      }
      return mockApp;
    });
  };

  const mockApp = {
    get: createMethodMock('GET'),
    post: createMethodMock('POST'),
    put: createMethodMock('PUT'),
    del: createMethodMock('DELETE'),
    patch: createMethodMock('PATCH'),
    options: createMethodMock('OPTIONS'),
    head: createMethodMock('HEAD'),
    any: createMethodMock('ANY'),
    connect: createMethodMock('CONNECT'),
    trace: createMethodMock('TRACE'),
    listen: jest.fn((...args: unknown[]) => {
      // Handle all listen overloads: (port, cb), (host, port, cb), (port, options, cb)
      const callback = args[args.length - 1] as (socket: unknown) => void;
      if (typeof callback === 'function') {
        callback(listenSocket);
      }
    }),
    listen_unix: jest.fn(),
    ws: jest.fn(),
    publish: jest.fn(),
    numSubscribers: jest.fn(),
    addServerName: jest.fn(),
    removeServerName: jest.fn(),
    missingServerName: jest.fn(),
  } as unknown as uWS.TemplatedApp;

  return {
    mockApp,
    registeredRoutes,
    listenSocket,
  };
}
