/* eslint-disable @typescript-eslint/no-explicit-any */
import * as uWS from 'uWebSockets.js';
import { UwsRequest } from './uws-request';
import { UwsResponse } from './uws-response';
import type { PlatformOptions } from '../interfaces';

/**
 * Route handler function type
 */
type RouteHandler = (req: UwsRequest, res: UwsResponse) => void | Promise<void>;

/**
 * Route information for tracking
 */
interface RouteInfo {
  method: string;
  path: string;
  uwsPath: string;
  pattern: string | RegExp;
  paramNames: string[];
  isComplex: boolean; // Uses regex matching instead of native uWS
  handler: RouteHandler; // Store the handler
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
 *    // ✅ Good - specific route first
 *    registry.register('GET', '/api/users/:id', handler1);
 *    registry.register('GET', '/api/*', handler2);
 *
 *    // ❌ Bad - general route first (will match everything)
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

  constructor(
    private readonly uwsApp: uWS.TemplatedApp,
    private readonly options: PlatformOptions
  ) {}

  /**
   * Register a route with uWS
   *
   * @param method - HTTP method (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, ALL)
   * @param path - Route path (NestJS format with :param or :param?)
   * @param handler - Route handler function
   * @throws Error if route is already registered
   */
  register(method: string, path: string, handler: RouteHandler): void {
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

              // Initialize body parser with configured size limit
              req._initBodyParser(this.options.maxBodySize || 1024 * 1024);

              // Execute handler with error handling
              await this.executeHandler(routeInfo.handler, req, res);

              break; // Stop after first match
            }
          }

          // If no route matched, send 404
          if (!matched) {
            const res = new UwsResponse(uwsRes);

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

          // Initialize body parser with configured size limit
          req._initBodyParser(this.options.maxBodySize || 1024 * 1024);

          // Execute handler with error handling
          await this.executeHandler(handler, req, res);
        }
      );
    }
  }

  /**
   * Execute a route handler with error handling
   *
   * Wraps handler execution with try/catch to handle errors gracefully.
   * Logs errors for debugging and sends a 500 response if headers haven't been sent.
   *
   * @param handler - Route handler function
   * @param req - Request wrapper
   * @param res - Response wrapper
   */
  private async executeHandler(
    handler: RouteHandler,
    req: UwsRequest,
    res: UwsResponse
  ): Promise<void> {
    try {
      await handler(req, res);
    } catch (error) {
      // Log error for debugging (server-side only)
      console.error('Unhandled route error:', error);

      // Handle errors - only send response if headers not sent
      if (!res.headersSent) {
        // Send generic error response without leaking internal details
        res.status(500);
        res.send({
          statusCode: 500,
          message: 'Internal Server Error',
        });
      }
    }
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
   * Based on ultimate-express implementation
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
}
