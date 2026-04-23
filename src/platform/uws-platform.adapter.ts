/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import { AbstractHttpAdapter } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import * as uWS from 'uWebSockets.js';
import { UwsAdapter } from '../adapter/uws.adapter';
import { UwsRequest } from './uws-request';
import { UwsResponse } from './uws-response';
import { RouteRegistry } from './route-registry';
import { CorsHandler } from './cors-handler';
import { StaticFileHandler } from './static-file-handler';
import type { PlatformOptions, CorsOptions } from '../interfaces';
import type { ModuleRef } from '../middleware/module-ref';

/**
 * Resolved platform options with defaults applied
 * Represents the actual runtime state after merging user options with defaults
 */
type ResolvedPlatformOptions = {
  // HTTP options (always defined)
  maxBodySize: number;
  trustProxy: boolean;
  etag: false | 'weak' | 'strong';
  bodyParser: {
    json: boolean;
    urlencoded: boolean;
    raw: boolean;
    text: boolean;
  };

  // WebSocket options (always defined)
  port: number;
  maxPayloadLength: number;
  idleTimeout: number;
  compression: uWS.CompressOptions;
  path: string;
  perMessageDeflate: boolean;
  maxBackpressure: number;
  closeOnBackpressureLimit: boolean;
  sendPingsAutomatically: boolean;

  // Optional options (may be undefined)
  cors?: CorsOptions;
  moduleRef?: ModuleRef;
  uwsApp?: uWS.TemplatedApp;
  key_file_name?: string;
  cert_file_name?: string;
  passphrase?: string;
  dh_params_file_name?: string;
  ssl_prefer_low_memory_usage?: boolean;
};

/**
 * HTTP Platform Adapter for uWebSockets.js
 *
 * Implements the NestJS AbstractHttpAdapter interface to provide HTTP support
 * using uWebSockets.js as the underlying server. This adapter integrates with
 * the existing WebSocket adapter to provide a unified HTTP + WebSocket server.
 *
 * Key features:
 * - High-performance HTTP request handling
 * - Shared uWS instance with WebSocket adapter
 * - Route registration and parameter extraction
 * - Request body parsing with size limits
 * - CORS support
 * - SSL/TLS support
 *
 * @example
 * ```typescript
 * const app = await NestFactory.create(AppModule, new UwsPlatformAdapter({
 *   maxBodySize: 10 * 1024 * 1024, // 10MB
 *   cors: {
 *     origin: 'https://example.com',
 *     credentials: true
 *   }
 * }));
 * await app.listen(3000);
 * ```
 */
export class UwsPlatformAdapter extends AbstractHttpAdapter {
  private uwsApp: uWS.TemplatedApp;
  private wsAdapter?: UwsAdapter;
  private listenSocket?: uWS.us_listen_socket;
  private readonly platformOptions: ResolvedPlatformOptions;
  private readonly routeRegistry: RouteRegistry;
  private readonly logger: Required<Pick<import('../interfaces').Logger, 'log' | 'debug' | 'warn'>>;
  private versioningWarningShown = false;
  private errorHandlerWarningShown = false;
  private notFoundHandlerWarningShown = false;

  /**
   * Show a warning message once per warning type
   * Uses the configured logger for consistency with other framework logging
   */
  private warnOnce(
    flag: 'versioningWarningShown' | 'errorHandlerWarningShown' | 'notFoundHandlerWarningShown',
    message: string
  ): void {
    if (this[flag]) return;
    this[flag] = true;
    this.logger.warn(message);
  }

  constructor(options: PlatformOptions = {}) {
    super();

    // Validate maxBodySize if provided
    if (options.maxBodySize !== undefined) {
      if (
        typeof options.maxBodySize !== 'number' ||
        !Number.isFinite(options.maxBodySize) ||
        options.maxBodySize <= 0 ||
        !Number.isInteger(options.maxBodySize)
      ) {
        throw new Error(
          `Invalid maxBodySize: ${options.maxBodySize}. Must be a positive integer. ` +
            `Received: ${typeof options.maxBodySize === 'number' ? options.maxBodySize : typeof options.maxBodySize}`
        );
      }
    }

    // Merge with defaults
    this.platformOptions = {
      // HTTP defaults
      maxBodySize: 1024 * 1024, // 1MB
      trustProxy: false,
      etag: 'weak',

      // WebSocket defaults (from v1.x)
      port: 8099,
      cors: undefined,
      perMessageDeflate: false,
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      maxBackpressure: 1024 * 1024,
      closeOnBackpressureLimit: false,
      sendPingsAutomatically: true,
      moduleRef: undefined,
      compression: uWS.SHARED_COMPRESSOR,
      path: '/*',

      // Merge user options
      ...options,

      // Merge nested bodyParser options
      bodyParser: {
        json: true,
        urlencoded: true,
        raw: false,
        text: false,
        ...options.bodyParser,
      },
    };

    // Create uWS App (HTTP + WebSocket capable)
    this.uwsApp = this.createUwsApp(options);

    // Initialize logger (use provided logger or default to console)
    this.logger = {
      log: options.logger?.log?.bind(options.logger) || console.log.bind(console),
      debug: options.logger?.debug?.bind(options.logger) || console.debug.bind(console),
      warn: options.logger?.warn?.bind(options.logger) || console.warn.bind(console),
    };

    // Create route registry
    this.routeRegistry = new RouteRegistry(this.uwsApp, this.platformOptions);
  }

  /**
   * Create uWS App instance (HTTP or HTTPS)
   *
   * If options.uwsApp is provided, returns it directly (shared server mode).
   * Otherwise, creates a new uWS.App() or uWS.SSLApp() based on SSL options.
   */
  private createUwsApp(options: PlatformOptions): uWS.TemplatedApp {
    // Use provided uwsApp if available (shared server mode)
    if (options.uwsApp) {
      return options.uwsApp;
    }

    // Check if SSL options are provided in UwsAdapterOptions
    const uwsOptions = options as any;
    const hasKey = !!uwsOptions.key_file_name;
    const hasCert = !!uwsOptions.cert_file_name;

    // Validate SSL configuration - both key and cert must be provided together
    if (hasKey !== hasCert) {
      throw new Error(
        'SSL configuration incomplete: both key_file_name and cert_file_name must be provided together. ' +
          `Received: key_file_name=${hasKey ? 'provided' : 'missing'}, cert_file_name=${hasCert ? 'provided' : 'missing'}`
      );
    }

    if (hasKey && hasCert) {
      // Create SSL app
      return uWS.SSLApp({
        key_file_name: uwsOptions.key_file_name,
        cert_file_name: uwsOptions.cert_file_name,
        passphrase: uwsOptions.passphrase,
        dh_params_file_name: uwsOptions.dh_params_file_name,
        ssl_prefer_low_memory_usage: uwsOptions.ssl_prefer_low_memory_usage,
      });
    }

    // Create non-SSL app
    return uWS.App();
  }

  /**
   * Initialize WebSocket adapter with the same uWS instance
   * This allows HTTP and WebSocket to share the same server
   */
  initWebSocketAdapter(httpServer: any): UwsAdapter {
    if (!this.wsAdapter) {
      this.wsAdapter = new UwsAdapter(httpServer, {
        ...this.platformOptions,
        uwsApp: this.uwsApp, // Share the uWS instance (v2.0.0+)
      });
    }
    return this.wsAdapter;
  }

  /**
   * Get the WebSocket adapter instance
   */
  getWebSocketAdapter(): UwsAdapter | undefined {
    return this.wsAdapter;
  }

  /**
   * Get the route registry instance (for debugging/testing)
   */
  getRouteRegistry(): RouteRegistry {
    return this.routeRegistry;
  }

  // ============================================================================
  // AbstractHttpAdapter Interface Implementation
  // ============================================================================

  /**
   * Start listening on the specified port and hostname
   *
   * Follows Node.js convention: callback is invoked with an error on failure,
   * or with no arguments on success.
   *
   * If no callback is provided and listening fails, the error is thrown asynchronously.
   */
  listen(port: number, callback?: (error?: Error) => void): void;
  listen(port: number, hostname: string, callback?: (error?: Error) => void): void;
  listen(port: number, ...args: any[]): void {
    const hostname = typeof args[0] === 'string' ? args[0] : '0.0.0.0';
    const callback = typeof args[0] === 'function' ? args[0] : args[1];

    this.uwsApp.listen(hostname, port, (socket) => {
      if (socket) {
        // Only set listenSocket after confirmed successful bind
        this.listenSocket = socket;
        if (callback) callback();
      } else {
        // Listen failed - perform cleanup
        // Note: uWS returns false when listen fails, meaning no socket was created
        // so there's no partial state to clean up. We just ensure listenSocket stays undefined.

        const error = new Error(`Failed to listen on ${hostname}:${port}`);
        if (callback) {
          // Pass error to callback (Node.js error-first callback convention)
          callback(error);
        } else {
          // No callback provided, throw asynchronously to crash the process
          // This is intentional - if the server can't listen, the app should not start
          process.nextTick(() => {
            throw error;
          });
        }
      }
    });
  }

  /**
   * Close the server and stop listening
   *
   * Closes the HTTP listen socket and cleans up the WebSocket adapter if present.
   * The WebSocket adapter will close all client connections and clear resources.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      // Close HTTP listen socket
      if (this.listenSocket) {
        uWS.us_listen_socket_close(this.listenSocket);
        this.listenSocket = undefined;
      }

      // Clean up WebSocket adapter if initialized
      // This closes all WebSocket connections and clears resources
      if (this.wsAdapter) {
        this.wsAdapter.close(null);
      }

      resolve();
    });
  }

  /**
   * Initialize HTTP server (no-op for uWS, already initialized in constructor)
   */
  initHttpServer(): void {
    // No-op - uWS app is already initialized in constructor
  }

  /**
   * Get the underlying HTTP server instance
   */
  getHttpServer(): uWS.TemplatedApp {
    return this.uwsApp;
  }

  /**
   * Get the underlying server instance (alias for getHttpServer)
   */
  getInstance<T = uWS.TemplatedApp>(): T {
    return this.getHttpServer() as T;
  }

  // ============================================================================
  // HTTP Method Registration
  // ============================================================================

  /**
   * Internal method to handle HTTP method registration with overload support
   */
  private handleMethodRegistration(method: string, ...args: any[]): any {
    if (args.length === 1) {
      // Single argument: global handler (not typically used in NestJS)
      // Return without registering to avoid breaking AbstractHttpAdapter contract
      return;
    }
    this.registerRoute(method, args[0], args[1]);
  }

  /** Register GET route */
  get(path: string, handler: Function): any;
  get(handler: Function): any;
  get(...args: any[]): any {
    return this.handleMethodRegistration('get', ...args);
  }

  /** Register POST route */
  post(path: string, handler: Function): any;
  post(handler: Function): any;
  post(...args: any[]): any {
    return this.handleMethodRegistration('post', ...args);
  }

  /** Register PUT route */
  put(path: string, handler: Function): any;
  put(handler: Function): any;
  put(...args: any[]): any {
    return this.handleMethodRegistration('put', ...args);
  }

  /** Register DELETE route */
  delete(path: string, handler: Function): any;
  delete(handler: Function): any;
  delete(...args: any[]): any {
    return this.handleMethodRegistration('delete', ...args);
  }

  /** Register PATCH route */
  patch(path: string, handler: Function): any;
  patch(handler: Function): any;
  patch(...args: any[]): any {
    return this.handleMethodRegistration('patch', ...args);
  }

  /** Register OPTIONS route */
  options(path: string, handler: Function): any;
  options(handler: Function): any;
  options(...args: any[]): any {
    return this.handleMethodRegistration('options', ...args);
  }

  /** Register HEAD route */
  head(path: string, handler: Function): any;
  head(handler: Function): any;
  head(...args: any[]): any {
    return this.handleMethodRegistration('head', ...args);
  }

  /** Register route for all HTTP methods */
  all(path: string, handler: Function): any;
  all(handler: Function): any;
  all(...args: any[]): any {
    return this.handleMethodRegistration('all', ...args);
  }

  /**
   * Internal method to register routes with uWS
   */
  private registerRoute(method: string, path: string, handler: Function): void {
    this.routeRegistry.register(method.toUpperCase(), path, handler as any);
  }

  /**
   * Register a route with metadata (guards, pipes, filters)
   *
   * Used by NestJS to register routes with their associated middleware metadata.
   * The metadata is passed to the route registry which executes the middleware pipeline.
   */
  registerRouteWithMetadata(
    method: string,
    path: string,
    handler: Function,
    metadata: import('./route-registry').RouteMetadata
  ): void {
    this.routeRegistry.register(method.toUpperCase(), path, handler as any, metadata);
  }

  // ============================================================================
  // Middleware Registration
  // ============================================================================

  /**
   * Register middleware (intentionally not supported)
   *
   * Express-style middleware is not compatible with uWebSockets.js architecture.
   * Use NestJS guards, interceptors, and pipes instead for request processing.
   *
   * @throws Error always - this method is not supported
   */
  use(path: string, handler: (...args: unknown[]) => unknown): void;
  use(handler: (...args: unknown[]) => unknown): void;
  use(..._args: unknown[]): void {
    throw new Error(
      'UwsPlatformAdapter does not support Express-style middleware. ' +
        'Use NestJS guards, interceptors, and pipes instead.'
    );
  }

  // ============================================================================
  // Response Helper Methods
  // ============================================================================

  /**
   * Send response with optional status code
   */
  reply(response: UwsResponse, body: unknown, statusCode?: number): void {
    if (statusCode) {
      response.status(statusCode);
    }
    response.send(body as string | Buffer | unknown[] | Record<string, unknown>);
  }

  /**
   * Set response status code
   */
  status(response: UwsResponse, statusCode: number): void {
    response.status(statusCode);
  }

  /**
   * Render view (not implemented)
   *
   * View rendering is handled by NestJS at a higher level through the
   * @Render() decorator and view engines. This low-level method is not needed.
   *
   * @throws Error always - use NestJS @Render() decorator instead
   */
  render(_response: UwsResponse, _view: string, _options: unknown): void {
    throw new Error('render() not implemented - use NestJS view rendering');
  }

  /**
   * Send redirect response
   */
  redirect(response: UwsResponse, statusCode: number, url: string): void {
    response.status(statusCode);
    response.setHeader('Location', url);
    response.send();
  }

  /**
   * Set response header
   */
  setHeader(response: UwsResponse, name: string, value: string): void {
    response.setHeader(name, value);
  }

  /**
   * Set error handler (not yet implemented)
   *
   * Custom error handlers at the adapter level are not yet supported.
   * Use NestJS exception filters (@Catch decorators) which provide more
   * powerful and flexible error handling capabilities.
   *
   * @param _handler - Error handler function (ignored)
   */
  setErrorHandler(_handler: (...args: unknown[]) => unknown): void {
    this.warnOnce(
      'errorHandlerWarningShown',
      'UwsPlatformAdapter: setErrorHandler not yet implemented. Use NestJS exception filters instead (@Catch decorators).'
    );
  }

  /**
   * Set not found handler (not yet implemented)
   *
   * Custom 404 handlers at the adapter level are not yet supported.
   * NestJS automatically returns 404 responses for unmatched routes.
   * Use exception filters if you need custom 404 handling.
   *
   * @param _handler - Not found handler function (ignored)
   */
  setNotFoundHandler(_handler: (...args: unknown[]) => unknown): void {
    this.warnOnce(
      'notFoundHandlerWarningShown',
      'UwsPlatformAdapter: setNotFoundHandler not yet implemented. NestJS handles 404s automatically through its routing system.'
    );
  }

  /**
   * Enable CORS for HTTP requests
   *
   * Configures Cross-Origin Resource Sharing (CORS) headers for all HTTP requests.
   * Handles both simple requests and preflight (OPTIONS) requests automatically.
   *
   * @param options - CORS configuration options
   *
   * @example
   * ```typescript
   * // Allow all origins
   * app.enableCors();
   *
   * // Allow specific origin
   * app.enableCors({ origin: 'https://example.com' });
   *
   * // Allow multiple origins
   * app.enableCors({ origin: ['https://example.com', 'https://app.example.com'] });
   *
   * // Dynamic origin validation
   * app.enableCors({
   *   origin: (origin) => origin?.endsWith('.example.com') ?? false,
   *   credentials: true
   * });
   * ```
   */
  enableCors(options?: CorsOptions): void {
    const corsHandler = new CorsHandler(options);

    // Register CORS handler with route registry
    // This will be called before all route handlers
    this.routeRegistry.registerCorsHandler(corsHandler);
  }

  /**
   * Create middleware proxy (required by AbstractHttpAdapter)
   *
   * This method is called by NestJS to create a middleware factory function
   * for a specific HTTP method. The factory function is then used to register
   * routes with their handlers.
   *
   * The returned function accepts a path and callback (handler), and registers
   * the route with the route registry. This allows NestJS to register routes
   * in a platform-agnostic way.
   *
   * @param requestMethod - HTTP method (RequestMethod enum or lowercase string)
   * @returns Factory function that registers routes
   *
   * @example
   * ```typescript
   * const factory = adapter.createMiddlewareFactory(RequestMethod.GET);
   * factory('/users', (req, res) => res.send('Hello'));
   * ```
   */
  createMiddlewareFactory(requestMethod: any): (path: string, callback: Function) => any {
    return (path: string, callback: Function): void => {
      // Convert RequestMethod enum to string if needed
      // Using the actual RequestMethod enum ensures automatic compatibility with NestJS version changes
      const methodMap: Record<number, string> = {
        [RequestMethod.GET]: 'GET',
        [RequestMethod.POST]: 'POST',
        [RequestMethod.PUT]: 'PUT',
        [RequestMethod.DELETE]: 'DELETE',
        [RequestMethod.PATCH]: 'PATCH',
        [RequestMethod.ALL]: 'ALL',
        [RequestMethod.OPTIONS]: 'OPTIONS',
        [RequestMethod.HEAD]: 'HEAD',
        [RequestMethod.SEARCH]: 'SEARCH',
        [RequestMethod.PROPFIND]: 'PROPFIND',
        [RequestMethod.PROPPATCH]: 'PROPPATCH',
        [RequestMethod.MKCOL]: 'MKCOL',
        [RequestMethod.COPY]: 'COPY',
        [RequestMethod.MOVE]: 'MOVE',
        [RequestMethod.LOCK]: 'LOCK',
        [RequestMethod.UNLOCK]: 'UNLOCK',
      };

      let method: string;
      if (typeof requestMethod === 'number') {
        method = methodMap[requestMethod];
        if (!method) {
          throw new Error(
            `Unsupported RequestMethod enum value: ${requestMethod}. ` +
              `Please update the uWS adapter method map for this @nestjs/common version.`
          );
        }
      } else {
        method = String(requestMethod).toUpperCase();
      }

      // Register route with the route registry
      this.routeRegistry.register(method, path, callback as any);
    };
  }

  /**
   * Get request hostname
   */
  getRequestHostname(request: UwsRequest): string {
    const host = request.get('host');
    return Array.isArray(host) ? host[0] : host || '';
  }

  /**
   * Get request method
   */
  getRequestMethod(request: UwsRequest): string {
    return request.method;
  }

  /**
   * Get request URL
   */
  getRequestUrl(request: UwsRequest): string {
    return request.originalUrl;
  }

  /**
   * Check if response headers have been sent
   */
  isHeadersSent(response: UwsResponse): boolean {
    return response.headersSent;
  }

  /**
   * Set response status message (not supported)
   *
   * uWebSockets.js does not support custom HTTP status messages.
   * Status messages are automatically determined by the status code
   * according to HTTP specifications (e.g., 200 -> "OK", 404 -> "Not Found").
   *
   * @param _response - Response object (ignored)
   * @param _message - Status message (ignored)
   */
  setStatusMessage(_response: UwsResponse, _message: string): void {
    // uWS doesn't support custom status messages
    // Status messages are determined by status code
  }

  /**
   * Get response header
   */
  getHeader(response: UwsResponse, name: string): string | string[] | undefined {
    return response.getHeader(name);
  }

  /**
   * Append header value
   */
  appendHeader(response: UwsResponse, name: string, value: string): void {
    const existing = response.getHeader(name);
    if (existing) {
      const values = Array.isArray(existing) ? existing : [existing];
      response.setHeader(name, [...values, value]);
    } else {
      response.setHeader(name, value);
    }
  }

  /**
   * End response
   */
  end(response: UwsResponse, message?: string): void {
    response.send(message);
  }

  /**
   * Set view engine (not needed)
   *
   * View engine configuration is handled by NestJS at the application level.
   * This adapter-level method is not needed for view rendering to work.
   *
   * @param _engine - View engine name (ignored)
   */
  setViewEngine(_engine: string): void {
    // No-op - NestJS handles view rendering
  }

  /**
   * Use static assets
   *
   * Serves static files from the specified directory with caching,
   * range requests, and security features.
   *
   * Registers a catch-all GET route (/*) that serves files from the specified
   * directory. This route is registered with the lowest priority to ensure
   * API routes take precedence.
   *
   * @param path - Root directory for static files
   * @param options - Static file serving options
   *
   * @example
   * ```typescript
   * app.useStaticAssets('public', {
   *   maxAge: 86400000, // 1 day
   *   etag: true,
   *   immutable: true
   * });
   * ```
   */
  useStaticAssets(
    path: string,
    options?: Partial<import('./static-file-handler').StaticFileOptions> & {
      silent?: boolean;
      prefix?: string;
    }
  ): void {
    // Validate path
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('Static assets path must be a non-empty string');
    }

    const { silent, prefix, ...handlerOptions } = options || {};

    const handler = new StaticFileHandler({
      root: path,
      ...handlerOptions,
    });

    if (!silent) {
      this.logger.log(`Static assets enabled from: ${path}`);
    }

    // Determine the route pattern based on prefix
    // Normalize prefix by removing trailing slash
    let routePattern = '/*';
    if (prefix) {
      const normalizedPrefix = prefix.trim().replace(/\/$/, '');
      if (normalizedPrefix) {
        routePattern = `${normalizedPrefix}/*`;
      }
    }

    // Register a catch-all route handler for static files
    // This should be registered AFTER all API routes to ensure proper priority
    // uWS routes are matched in registration order, so registering this last
    // ensures API routes take precedence
    const staticAssetHandler = async (req: UwsRequest, res: UwsResponse) => {
      try {
        // Extract the file path by removing the prefix if present
        let filePath = req.path;
        if (prefix) {
          const normalizedPrefix = prefix.trim().replace(/\/$/, '');
          if (normalizedPrefix && filePath.startsWith(normalizedPrefix)) {
            filePath = filePath.substring(normalizedPrefix.length);
          }
        }

        await handler.serve(req, res, filePath);
      } catch (error) {
        // Log error for diagnostics (could be file not found or actual error)
        this.logger.debug(`Static file error for ${req.path}:`, error);

        // If file not found or error, send 404
        if (!res.headersSent && !res.isAborted) {
          res.status(404);
          res.send({
            statusCode: 404,
            message: 'Not Found',
          });
        }
      }
    };

    // Register for both GET and HEAD methods
    this.get(routePattern, staticAssetHandler as Function);
    this.head(routePattern, staticAssetHandler as Function);
  }

  /**
   * Register parser middleware (not needed - handled by BodyParser)
   */
  registerParserMiddleware(): void {
    // Body parsing is handled by BodyParser class
  }

  /**
   * Apply version filter (not yet implemented)
   *
   * API versioning is not yet supported. This method bypasses version filtering
   * and returns the handler unchanged. All route versions will be accessible
   * regardless of the requested version.
   *
   * A warning is logged once when versioning is attempted to inform developers
   * that version filtering is not active.
   *
   * @param handler - Route handler function
   * @param _version - Version constraint (ignored)
   * @param _versioningOptions - Versioning options (ignored)
   * @returns The original handler unchanged
   */
  applyVersionFilter(
    handler: Function,
    _version: any,
    _versioningOptions: any
  ): (req: any, res: any, next: () => void) => Function {
    if (_version !== undefined || _versioningOptions !== undefined) {
      this.warnOnce(
        'versioningWarningShown',
        '[UwsPlatformAdapter] API versioning is not yet supported. Version filters have been bypassed. All route versions will be accessible.'
      );
    }
    return handler as (req: any, res: any, next: () => void) => Function;
  }

  /**
   * Get type (required by AbstractHttpAdapter)
   */
  getType(): string {
    return 'uws';
  }
}
