import { ExecutionContext, Type } from '@nestjs/common';
import { UwsRequest } from './request';
import { UwsResponse } from './response';

/**
 * Handler function type for route handlers
 */
type RouteHandler = (req: UwsRequest, res: UwsResponse) => void | Promise<void>;

/**
 * uWebSockets.js doesn't use Express-style next() middleware chaining,
 * so getNext() returns this shared no-op to avoid allocating closures on every call.
 */
const NOOP_NEXT = () => {};

/**
 * HTTP execution context for NestJS.
 * Provides access to request, response, and handler metadata for guards, interceptors, and pipes.
 *
 * Note: This class implements NestJS's ExecutionContext interface which requires
 * generic types (any, Function) for framework compatibility. We use more specific
 * internal types where possible while maintaining interface compliance.
 */
export class HttpExecutionContext implements ExecutionContext {
  constructor(
    private request: UwsRequest,
    private response: UwsResponse,
    private handler: RouteHandler,
    private classRef: Type<unknown> | undefined
  ) {}

  /**
   * Returns the class (controller) that contains the handler.
   * @throws Error if no controller class is associated with this context
   */
  getClass<T = unknown>(): Type<T> {
    if (!this.classRef) {
      throw new Error(
        'Controller class reference is not available. ' +
          'This may occur with global middleware or routes registered without controller metadata.'
      );
    }
    return this.classRef as Type<T>;
  }

  /**
   * Returns the handler (route method) being executed.
   */
  getHandler(): RouteHandler {
    return this.handler;
  }

  /**
   * Returns the arguments array [request, response].
   */
  getArgs<T extends unknown[] = [UwsRequest, UwsResponse]>(): T {
    return [this.request, this.response] as T;
  }

  /**
   * Returns a specific argument by index.
   * @param index - 0 for request, 1 for response
   * @returns The argument at the specified index, or `undefined` for out-of-bounds indices.
   * Note: The return type follows NestJS's interface contract; callers should handle potential undefined values.
   */
  getArgByIndex<T = UwsRequest | UwsResponse>(index: number): T {
    const args = this.getArgs();
    if (index < 0 || index >= args.length) {
      return undefined as T;
    }
    return args[index] as T;
  }

  /**
   * Not supported - throws error.
   * Use switchToHttp() for HTTP context.
   */
  switchToRpc(): never {
    throw new Error('RPC context not supported in HTTP execution context');
  }

  /**
   * Switches to HTTP context and provides access to request/response.
   */
  switchToHttp(): {
    getRequest: <T = UwsRequest>() => T;
    getResponse: <T = UwsResponse>() => T;
    getNext: <T = () => void>() => T;
  } {
    return {
      getRequest: <T = UwsRequest>() => this.request as T,
      getResponse: <T = UwsResponse>() => this.response as T,
      getNext: <T = () => void>() => NOOP_NEXT as T,
    };
  }

  /**
   * Not supported in HTTP context - throws error.
   * This is for WebSocket gateway execution contexts.
   */
  switchToWs(): never {
    throw new Error('WebSocket context not supported in HTTP execution context');
  }

  /**
   * Returns the context type identifier.
   */
  getType<TContext extends string = 'http'>(): TContext {
    return 'http' as TContext;
  }
}
