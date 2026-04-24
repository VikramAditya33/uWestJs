/* eslint-disable @typescript-eslint/no-explicit-any */
import * as uWS from 'uWebSockets.js';
import { isObservable, lastValueFrom } from 'rxjs';
import { UwsRequest } from '../core/request';
import { UwsResponse } from '../core/response';
import { HttpExecutionContext } from '../core/context';
import type { PlatformOptions, Logger } from '../../shared/interfaces';
import type { CorsHandler } from '../handlers/cors/cors-handler';
import type {
  CanActivate,
  PipeTransform,
  ExceptionFilter,
  Type,
  ExecutionContext,
  ArgumentsHost,
  ArgumentMetadata,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { ModuleRef, DefaultModuleRef } from '../../shared/di';

/**
 * Route handler function type
 */
export type RouteHandler = (req: UwsRequest, res: UwsResponse) => void | Promise<void>;

/**
 * Route metadata for middleware execution
 */
export interface RouteMetadata {
  /**
   * Controller class reference
   */
  classRef?: Type<unknown>;

  /**
   * Guards to execute before handler
   */
  guards?: Type<CanActivate>[];

  /**
   * Pipes to execute on request body
   */
  pipes?: Type<PipeTransform>[];

  /**
   * Exception filters to handle errors
   */
  filters?: Type<ExceptionFilter>[];

  /**
   * Optional argument metadata for pipe transformation
   *
   * Provides type information to pipes (especially ValidationPipe) so they can
   * perform proper validation and transformation based on the DTO class.
   *
   * @example
   * ```typescript
   * registry.register('POST', '/users', handler, {
   *   pipes: [ValidationPipe],
   *   bodyMetadata: {
   *     type: 'body',
   *     metatype: CreateUserDto,  // ValidationPipe uses this
   *     data: undefined,
   *   },
   * });
   * ```
   */
  bodyMetadata?: ArgumentMetadata;
}

/**
 * Route information for tracking
 */
export interface RouteInfo {
  method: string;
  path: string;
  uwsPath: string;
  pattern: string | RegExp;
  paramNames: string[];
  isComplex: boolean; // Uses regex matching instead of native uWS
  handler: RouteHandler; // Store the handler
  metadata?: RouteMetadata; // Middleware metadata
}

/**
 * Route Registry for managing HTTP routes
 *
 * Handles route registration, path conversion, and parameter extraction.
 * Converts NestJS route patterns to uWebSockets.js format and manages
 * the lifecycle of HTTP requests.
 *
 * Key responsibilities:
 * - Convert NestJS path patterns (:param) to uWS format
 * - Extract parameter names from paths
 * - Register routes with uWS
 * - Create request/response wrappers
 * - Initialize body parser
 * - Handle errors
 * - Resolve guards, pipes, and filters from DI container
 *
 * ## Dependency Injection Support
 *
 * Guards, pipes, and filters are resolved from the DI container using ModuleRef.
 * This allows them to have constructor dependencies (e.g., ConfigService, JwtService).
 *
 * When no ModuleRef is provided, falls back to DefaultModuleRef which instantiates
 * classes directly (only supports parameterless constructors).
 *
 * @example
 * ```typescript
 * // With DI support
 * const registry = new RouteRegistry(uwsApp, {
 *   moduleRef: NestJsModuleRef.create(moduleRef)
 * });
 *
 * // Without DI (tests or simple setups)
 * const registry = new RouteRegistry(uwsApp, {});
 * ```
 *
 * ## Route Matching Order
 *
 * Routes are matched in **registration order** (first-registered, first-matched).
 * This follows Express.js convention and is the expected behavior for most web frameworks.
 *
 * **Important:** When multiple routes share the same wildcard prefix, they are tried
 * in the order they were registered. The first matching route handles the request.
 *
 * ### Best Practices:
 *
 * 1. **Register specific routes before general ones:**
 *    ```typescript
 *    // Good - specific route first
 *    registry.register('GET', '/api/users/:id', handler1);
 *    registry.register('GET', '/api/*', handler2);
 *
 *    // Bad - general route first (will match everything)
 *    registry.register('GET', '/api/*', handler2);
 *    registry.register('GET', '/api/users/:id', handler1); // Never reached!
 *    ```
 *
 * 2. **Order routes by specificity:**
 *    - Static paths first: `/api/users/me`
 *    - Required parameters: `/api/users/:id`
 *    - Optional parameters: `/api/users/:id?`
 *    - Wildcards last: `/api/*`
 *
 * 3. **NestJS handles this automatically** when using decorators - routes are
 *    registered in the order controllers and methods are defined.
 *
 * @example
 * ```typescript
 * const registry = new RouteRegistry(uwsApp, options);
 *
 * // Specific routes first
 * registry.register('GET', '/users/me', (req, res) => {
 *   res.json({ user: 'current' });
 * });
 *
 * // Then parameterized routes
 * registry.register('GET', '/users/:id', (req, res) => {
 *   res.json({ id: req.params.id });
 * });
 *
 * // General routes last
 * registry.register('GET', '/users/*', (req, res) => {
 *   res.json({ message: 'catch-all' });
 * });
 * ```
 */
export class RouteRegistry {
  private routes = new Map<string, RouteInfo>();
  // Track complex routes by their wildcard registration path
  private complexRoutesByWildcard = new Map<string, RouteInfo[]>();
  private readonly logger: Required<Pick<Logger, 'error' | 'warn'>>;
  // Resolved module reference for DI-aware middleware instantiation
  private readonly moduleRef: ModuleRef;
  // CORS handler (optional)
  private corsHandler?: CorsHandler;

  constructor(
    private readonly uwsApp: uWS.TemplatedApp,
    private readonly options: PlatformOptions
  ) {
    // Use provided logger or default to console
    this.logger = {
      error: options.logger?.error?.bind(options.logger) || console.error.bind(console),
      warn: options.logger?.warn?.bind(options.logger) || console.warn.bind(console),
    };
    // Use provided ModuleRef (full NestJS DI) or fall back to DefaultModuleRef
    // (no-arg constructors only — matches existing WebSocket executor behavior)
    this.moduleRef = options.moduleRef ?? new DefaultModuleRef();
  }

  /**
   * Register a route with uWS
   *
   * @param method - HTTP method (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, ALL)
   * @param path - Route path (NestJS format with :param or :param?)
   * @param handler - Route handler function
   * @param metadata - Optional middleware metadata (guards, pipes, filters)
   * @throws Error if route is already registered
   */
  register(method: string, path: string, handler: RouteHandler, metadata?: RouteMetadata): void {
    // Convert method to uWS format and normalize to uppercase for consistency
    const uwsMethod = this.convertMethod(method);
    const normalizedMethod = method.toUpperCase();

    // Check if path has complex patterns (optional params, wildcards, etc.)
    const isComplex = this.needsRegexMatching(path);

    // Convert path and extract parameter names
    const uwsPath = this.convertPath(path);
    const paramNames = this.extractParamNames(path);
    const pattern = isComplex ? this.pathToRegex(path) : uwsPath;

    // Check for duplicate route registration using normalized method
    const routeKey = `${normalizedMethod}:${path}`;
    if (this.routes.has(routeKey)) {
      throw new Error(
        `Route already registered: ${normalizedMethod} ${path}. ` +
          `Duplicate route registration is not allowed as it would cause multiple handlers to execute for the same route.`
      );
    }

    // Track registered route with normalized method
    this.routes.set(routeKey, {
      method: normalizedMethod,
      path,
      uwsPath,
      pattern,
      paramNames,
      isComplex,
      handler,
      metadata,
    });

    // Get the uWS method function
    const uwsMethodFn = this.uwsApp[uwsMethod as keyof uWS.TemplatedApp] as any;

    if (typeof uwsMethodFn !== 'function') {
      throw new Error(`Invalid HTTP method: ${method} (converted to: ${uwsMethod})`);
    }

    if (isComplex) {
      // For complex routes, register with a wildcard pattern
      // Extract static prefix for more specific matching
      const staticPrefix = this.extractStaticPrefix(path);
      const registrationPath = staticPrefix ? `${staticPrefix}/*` : '/*';
      const wildcardKey = `${uwsMethod}:${registrationPath}`;

      // Add to complex routes collection
      if (!this.complexRoutesByWildcard.has(wildcardKey)) {
        this.complexRoutesByWildcard.set(wildcardKey, []);

        // Create the shared handler function that will be used for both wildcard and bare routes
        const sharedHandler = async (uwsRes: uWS.HttpResponse, uwsReq: uWS.HttpRequest) => {
          const requestPath = uwsReq.getUrl();
          const routesForWildcard = this.complexRoutesByWildcard.get(wildcardKey) || [];

          // Try to find a matching route
          let matched = false;
          for (const routeInfo of routesForWildcard) {
            const matches = this.matchPath(routeInfo.pattern as RegExp, requestPath);

            if (matches) {
              matched = true;

              // Create request/response wrappers
              const req = new UwsRequest(uwsReq, uwsRes, []);
              const res = new UwsResponse(uwsRes);

              // Set extracted parameters using proper API
              req._setParams(matches);

              // Initialize body parser with configured size limit and fast abort option
              // Pass response for abort multiplexing
              req._initBodyParser(
                this.options.maxBodySize ?? 1024 * 1024,
                this.options.fastAbort ?? false,
                res
              );

              // Execute handler with error handling
              await this.executeHandler(routeInfo.handler, req, res, routeInfo.metadata);

              break; // Stop after first match
            }
          }

          // If no route matched, send 404
          if (!matched) {
            const req = new UwsRequest(uwsReq, uwsRes, []);
            const res = new UwsResponse(uwsRes);

            // Handle CORS for unmatched routes (including preflight)
            if (this.corsHandler && (await this.corsHandler.handle(req, res))) {
              return;
            }

            // Only send 404 if response hasn't been sent and isn't aborted
            // UwsResponse.send() already handles aborted state, but checking here
            // avoids unnecessary work and makes intent explicit
            if (!res.headersSent && !res.isAborted) {
              res.status(404);
              res.send({
                statusCode: 404,
                message: 'Not Found',
              });
            }
          }
        };

        // Register the wildcard route (e.g., /users/*)
        uwsMethodFn.call(this.uwsApp, registrationPath, sharedHandler);

        // Register companion bare route for the static prefix (e.g., /users)
        // This is necessary because uWS wildcards like /users/* do NOT match /users (bare path)
        // For routes with optional parameters like /users/:id?, we need both registrations
        // to handle both /users and /users/123
        if (staticPrefix) {
          uwsMethodFn.call(this.uwsApp, staticPrefix, sharedHandler);
        }
      }

      // Add this route to the wildcard's route list
      this.complexRoutesByWildcard.get(wildcardKey)!.push({
        method: normalizedMethod,
        path,
        uwsPath,
        pattern,
        paramNames,
        isComplex,
        handler,
        metadata,
      });
    } else {
      // Simple route - use native uWS routing
      uwsMethodFn.call(
        this.uwsApp,
        uwsPath,
        async (uwsRes: uWS.HttpResponse, uwsReq: uWS.HttpRequest) => {
          // Create request/response wrappers
          const req = new UwsRequest(uwsReq, uwsRes, paramNames);
          const res = new UwsResponse(uwsRes);

          // Initialize body parser with configured size limit and fast abort option
          req._initBodyParser(
            this.options.maxBodySize ?? 1024 * 1024,
            this.options.fastAbort ?? false
          );

          // Execute handler with error handling
          await this.executeHandler(handler, req, res, metadata);
        }
      );
    }
  }

  /**
   * Execute a route handler with middleware pipeline
   *
   * Executes the full middleware pipeline:
   * 1. Guards - Authorization checks
   * 2. Body parsing - Parse request body if present
   * 3. Pipes - Transform/validate body
   * 4. Handler - Execute route handler
   * 5. Exception filters - Handle errors
   *
   * @param handler - Route handler function
   * @param req - Request wrapper
   * @param res - Response wrapper
   * @param metadata - Optional middleware metadata
   */
  private async executeHandler(
    handler: RouteHandler,
    req: UwsRequest,
    res: UwsResponse,
    metadata?: RouteMetadata
  ): Promise<void> {
    try {
      // 0. Handle CORS if enabled
      if (this.corsHandler) {
        const handled = await this.corsHandler.handle(req, res);
        // If preflight was handled (OPTIONS request), stop here
        if (handled) {
          return;
        }
      }

      // Create execution context for middleware
      const context = new HttpExecutionContext(req, res, handler, metadata?.classRef);

      // 1. Execute guards
      // Guards can either:
      // - Return false → 403 Forbidden (handled here)
      // - Throw exception → Propagates to exception filters (preserves HttpException status)
      if (metadata?.guards && metadata.guards.length > 0) {
        const canActivate = await this.executeGuards(context, metadata.guards);

        if (!canActivate) {
          if (!res.headersSent) {
            res.status(403).send({
              statusCode: 403,
              message: 'Forbidden',
            });
          }
          return;
        }
      }

      // 2. Parse body if content-type header is present
      let body: unknown;
      if (req.contentType) {
        body = await req.body;
      }

      // 3. Execute pipes on body
      // Run pipes if content-type was present (body was parsed), even for falsy values like null, 0, "", false
      if (metadata?.pipes && metadata.pipes.length > 0 && req.contentType) {
        body = await this.executePipes(metadata.pipes, body, metadata.bodyMetadata);
        // Attach transformed body to request so handler can access it via req.body
        req._setTransformedBody(body);
      }

      // 4. Execute handler
      const result = await handler(req, res);

      // 5. Send result if not already sent
      if (!res.headersSent && result !== undefined) {
        res.send(result);
      }
    } catch (error) {
      // Execute exception filters
      await this.handleException(error as Error, req, res, handler, metadata);
    }
  }

  /**
   * Execute guards for authorization
   *
   * Guards can control access in two ways:
   * 1. Return false → Results in 403 Forbidden response
   * 2. Throw exception → Handled by exception filters (can preserve HttpException status codes)
   *
   * This matches NestJS behavior where guards throwing HttpException (e.g., UnauthorizedException)
   * are handled by exception filters, allowing custom status codes and responses.
   *
   * @param context - Execution context
   * @param guards - Guard types to execute
   * @returns true if all guards pass, false if any guard denies access
   * @throws Error if guard throws (will be handled by exception filters)
   */
  private async executeGuards(
    context: HttpExecutionContext,
    guards: Type<CanActivate>[]
  ): Promise<boolean> {
    for (const GuardType of guards) {
      try {
        // Resolve guard from DI container (or instantiate if no DI)
        const guard = this.moduleRef.get(GuardType);

        // Execute guard - cast to ExecutionContext for compatibility
        // Guards can return boolean, Promise<boolean>, or Observable<boolean>
        const guardResult = guard.canActivate(context as ExecutionContext);
        const canActivate = isObservable(guardResult)
          ? await lastValueFrom(guardResult, { defaultValue: false })
          : await guardResult;

        if (!canActivate) {
          return false;
        }
      } catch (error) {
        // Guard threw an error - propagate to exception filters
        // This allows HttpException status codes to be preserved
        this.logger.error(`Guard ${GuardType.name} threw an error:`, error);
        throw error;
      }
    }

    return true;
  }

  /**
   * Execute pipes for transformation/validation
   *
   * @param pipes - Pipe types to execute
   * @param value - Value to transform
   * @param argMetadata - Optional argument metadata for pipes (provides metatype for validation)
   * @returns Transformed value
   */
  private async executePipes(
    pipes: Type<PipeTransform>[],
    value: unknown,
    argMetadata?: ArgumentMetadata
  ): Promise<unknown> {
    let transformedValue = value;

    // Use provided metadata or default to body with undefined metatype
    const metadata: ArgumentMetadata = argMetadata ?? {
      type: 'body',
      metatype: undefined,
      data: undefined,
    };

    for (const PipeType of pipes) {
      try {
        // Resolve pipe from DI container (or instantiate if no DI)
        const pipe = this.moduleRef.get(PipeType);

        // Execute pipe - pipes can return value, Promise<value>, or Observable<value>
        const pipeResult = pipe.transform(transformedValue, metadata);
        transformedValue = isObservable(pipeResult)
          ? await lastValueFrom(pipeResult)
          : await pipeResult;
      } catch (error) {
        // Pipe threw an error - propagate to exception filters
        this.logger.error(`Pipe ${PipeType.name} threw an error:`, error);
        throw error;
      }
    }

    return transformedValue;
  }

  /**
   * Handle exceptions with filters
   *
   * @param error - Error that was thrown
   * @param req - Request wrapper
   * @param res - Response wrapper
   * @param handler - Route handler
   * @param metadata - Optional middleware metadata
   */
  private async handleException(
    error: Error,
    req: UwsRequest,
    res: UwsResponse,
    handler: RouteHandler,
    metadata?: RouteMetadata
  ): Promise<void> {
    // Log error for debugging (server-side only)
    this.logger.error('Unhandled route error:', error);

    // Execute exception filters if provided
    if (metadata?.filters && metadata.filters.length > 0) {
      const context = new HttpExecutionContext(req, res, handler, metadata.classRef);
      const filterErrors: Array<{ filterName: string; error: Error }> = [];

      for (const FilterType of metadata.filters) {
        try {
          // Resolve filter from DI container (or instantiate if no DI)
          const filter = this.moduleRef.get(FilterType);

          // Create arguments host
          const host = this.createArgumentsHost(context);

          // Execute filter
          await filter.catch(error, host);

          // If filter handled the error and sent a response, we're done
          if (res.headersSent) {
            // If any filters failed, log them for debugging
            if (filterErrors.length > 0) {
              this.logger.error(
                `${filterErrors.length} exception filter(s) failed before successful handling:`,
                filterErrors
              );
            }
            return;
          }
        } catch (filterError) {
          // Accumulate filter errors for debugging
          filterErrors.push({
            filterName: FilterType.name,
            error: filterError as Error,
          });
          this.logger.error(`Exception filter ${FilterType.name} threw an error:`, filterError);
        }
      }

      // If all filters failed or none handled the error, log accumulated errors
      if (filterErrors.length > 0) {
        this.logger.error(
          `All ${filterErrors.length} exception filter(s) failed to handle the error:`,
          filterErrors
        );
      }
    }

    // Default error handling if no filter handled it
    if (!res.headersSent) {
      // Check if error is an HttpException to preserve status code
      if (error instanceof HttpException) {
        const status = error.getStatus();
        const response = error.getResponse();

        // If response is an object, use it; otherwise create a standard error object
        const errorResponse: Record<string, unknown> =
          typeof response === 'object' && response !== null
            ? (response as Record<string, unknown>)
            : {
                statusCode: status,
                message: typeof response === 'string' ? response : error.message,
              };

        res.status(status).send(errorResponse);
      } else {
        // Send generic error response for non-HTTP exceptions
        res.status(500).send({
          statusCode: 500,
          message: 'Internal Server Error',
        });
      }
    }
  }

  /**
   * Create ArgumentsHost for exception filters
   *
   * @param context - Execution context
   * @returns ArgumentsHost compatible object
   */
  private createArgumentsHost(context: HttpExecutionContext): ArgumentsHost {
    return {
      getArgs: <T extends Array<unknown> = [UwsRequest, UwsResponse]>() => context.getArgs<T>(),
      getArgByIndex: <T = UwsRequest | UwsResponse>(index: number) =>
        context.getArgByIndex<T>(index),
      switchToHttp: () => context.switchToHttp(),
      switchToRpc: () => {
        throw new Error('RPC context not supported in HTTP');
      },
      switchToWs: () => {
        throw new Error('WebSocket context not supported in HTTP');
      },
      getType: <TContext extends string = 'http'>() => 'http' as TContext,
    };
  }
  /**
   * Extract static prefix from path for more specific wildcard matching
   *
   * @param path - Path pattern
   * @returns Static prefix before first dynamic segment
   *
   * @example
   * extractStaticPrefix('/users/:id?') → '/users'
   * extractStaticPrefix('/api/v1/posts/:id') → '/api/v1/posts'
   * extractStaticPrefix('/:id') → ''
   */
  private extractStaticPrefix(path: string): string {
    const firstDynamic = path.search(/[:*]/);
    if (firstDynamic === -1) {
      return path;
    }
    if (firstDynamic === 0) {
      return '';
    }
    // Get everything before the first dynamic segment
    const prefix = path.substring(0, firstDynamic);
    // Remove trailing slash
    return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  }

  /**
   * Check if path needs regex matching (has complex patterns)
   *
   * @param path - Path pattern
   * @returns true if path has optional params, wildcards, or regex patterns
   */
  private needsRegexMatching(path: string): boolean {
    return (
      path.includes('?') || // Optional parameters
      path.includes('*') || // Wildcards
      path.includes('(') || // Regex patterns
      path.includes(')')
    );
  }

  /**
   * Convert path pattern to regex for matching
   *
   * Supports Express-style path patterns:
   * - Named parameters: /users/:id
   * - Optional parameters: /users/:id?
   * - Wildcards: /files/*
   *
   * @param path - Path pattern (e.g., /users/:id?)
   * @returns RegExp for matching requests
   */
  private pathToRegex(path: string): RegExp {
    let regexPattern = path
      // Escape all regex metacharacters except those we handle specially (*, :, ?)
      // This prevents malformed regex if paths contain characters like +, ^, $, [, ], {, }, |
      .replace(/[.+^${}|[\]\\]/g, '\\$&')
      .replace(/-/g, '\\-')
      // Handle wildcards
      .replace(/\*/g, '.*')
      // Handle parameters with optional marker
      // Pattern: /:param? or /:param
      // This matches the slash + colon + param name + optional ?
      .replace(/\/:(\w+)(\?)?/g, (match, param, optional) => {
        if (optional) {
          // Optional: \/?(?<param>[^/]+)?
          // The slash is optional, and the capture group is optional
          return `\\/?(?<${param}>[^/]+)?`;
        } else {
          // Required: \/(?<param>[^/]+)
          return `\\/(?<${param}>[^/]+)`;
        }
      });

    return new RegExp(`^${regexPattern}$`);
  }

  /**
   * Match a request path against a regex pattern and extract parameters
   *
   * @param pattern - Regex pattern
   * @param path - Request path
   * @returns Extracted parameters or null if no match
   */
  private matchPath(pattern: RegExp, path: string): Record<string, string> | null {
    // Remove trailing slash for matching (except for root)
    const normalizedPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

    const match = pattern.exec(normalizedPath);

    if (!match) {
      return null;
    }

    // Return empty params if no named groups (e.g., wildcard-only routes like /files/*)
    if (!match.groups) {
      return {};
    }

    // Extract named groups as parameters
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(match.groups)) {
      if (value !== undefined) {
        params[name] = value;
      }
    }

    return params;
  }

  /**
   * Convert NestJS path pattern to uWS format
   *
   * For simple routes (no optional params), NestJS and uWS both use :param syntax.
   * For complex routes (with optional params), we use regex matching instead.
   *
   * @param nestPath - NestJS path pattern (e.g., /users/:id or /users/:id?)
   * @returns uWS path pattern (e.g., /users/:id)
   *
   * @example
   * convertPath('/users/:id') → '/users/:id' (simple route)
   * convertPath('/users/:id?') → '/users/:id' (complex route, will use regex)
   * convertPath('/files/*') → '/files/*' (wildcard)
   */
  private convertPath(nestPath: string): string {
    // Remove optional markers for uWS path (regex will handle optionality)
    return nestPath.replace(/\?/g, '');
  }

  /**
   * Extract parameter names from path pattern
   *
   * Extracts all :param and :param? patterns from the path and returns their names
   * in the order they appear. This is used to map uWS parameter indices
   * to parameter names for simple routes.
   *
   * @param path - Path pattern with :param or :param? syntax
   * @returns Array of parameter names in order
   *
   * @example
   * extractParamNames('/users/:id') → ['id']
   * extractParamNames('/users/:userId/posts/:postId') → ['userId', 'postId']
   * extractParamNames('/users/:id?') → ['id']
   * extractParamNames('/static/file.txt') → []
   */
  private extractParamNames(path: string): string[] {
    const matches = path.matchAll(/:(\w+)\??/g);
    return Array.from(matches, (m) => m[1]);
  }

  /**
   * Convert HTTP method to uWS method name
   *
   * Maps standard HTTP methods to uWS method names.
   * Most methods are lowercase, with special cases for DELETE and ALL.
   *
   * @param method - HTTP method (uppercase)
   * @returns uWS method name (lowercase)
   *
   * @example
   * convertMethod('GET') → 'get'
   * convertMethod('POST') → 'post'
   * convertMethod('DELETE') → 'del'
   * convertMethod('ALL') → 'any'
   */
  private convertMethod(method: string): string {
    const methodMap: Record<string, string> = {
      GET: 'get',
      POST: 'post',
      PUT: 'put',
      DELETE: 'del',
      PATCH: 'patch',
      OPTIONS: 'options',
      HEAD: 'head',
      ALL: 'any',
    };

    const uwsMethod = methodMap[method.toUpperCase()];
    if (!uwsMethod) {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }

    return uwsMethod;
  }

  /**
   * Get all registered routes (for debugging)
   *
   * @returns Map of route keys to route information
   */
  getRoutes(): Map<string, RouteInfo> {
    return new Map(this.routes);
  }

  /**
   * Check if a route is registered
   *
   * @param method - HTTP method
   * @param path - Route path
   * @returns true if route is registered
   */
  hasRoute(method: string, path: string): boolean {
    const normalizedMethod = method.toUpperCase();
    const routeKey = `${normalizedMethod}:${path}`;
    return this.routes.has(routeKey);
  }

  /**
   * Get route count (for debugging)
   *
   * @returns Number of registered routes
   */
  getRouteCount(): number {
    return this.routes.size;
  }

  /**
   * Register CORS handler
   *
   * Registers a CORS handler and adds an OPTIONS catch-all route to handle
   * preflight requests to unregistered paths.
   *
   * @param handler - CORS handler instance
   */
  registerCorsHandler(handler: CorsHandler): void {
    if (!handler) {
      throw new Error('CORS handler cannot be null or undefined');
    }
    if (typeof handler.handle !== 'function') {
      throw new Error('CORS handler must have a handle method');
    }
    const isFirstRegistration = !this.corsHandler;

    if (this.corsHandler) {
      this.logger.warn('CORS handler is being replaced. This may indicate a configuration issue.');
    }
    this.corsHandler = handler;

    // Only register OPTIONS catch-all once; subsequent calls just update the handler reference
    if (isFirstRegistration) {
      this.uwsApp.options('/*', async (uwsRes: uWS.HttpResponse, uwsReq: uWS.HttpRequest) => {
        const req = new UwsRequest(uwsReq, uwsRes, []);
        const res = new UwsResponse(uwsRes);

        // Use this.corsHandler to pick up the latest handler
        if (this.corsHandler && (await this.corsHandler.handle(req, res))) {
          return;
        }

        // If CORS handler didn't handle it (e.g., origin not allowed), send 404
        if (!res.headersSent && !res.isAborted) {
          res.status(404).send({
            statusCode: 404,
            message: 'Not Found',
          });
        }
      });
    }
  }
}
