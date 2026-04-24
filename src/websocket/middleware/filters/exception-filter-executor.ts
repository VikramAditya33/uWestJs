import { ArgumentsHost, ExceptionFilter, HttpException, Logger, Type } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { WsException } from '../../exceptions/ws-exception';
import { DefaultModuleRef, ModuleRef } from '../../../shared/di';
import { WsContext } from '../ws-context';

/**
 * WebSocket arguments host for exception filters
 * Extends the base WsContext with filter-specific functionality
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WsArgumentsHost extends WsContext {}

/**
 * Executes exception filters when errors occur
 */
export class ExceptionFilterExecutor {
  private readonly logger = new Logger(ExceptionFilterExecutor.name);
  private readonly moduleRef: ModuleRef;

  /**
   * Creates an exception filter executor
   * @param moduleRef - Optional module reference for DI
   */
  constructor(moduleRef?: ModuleRef) {
    this.moduleRef = moduleRef || new DefaultModuleRef();
  }

  /**
   * Catches and handles exceptions using filters
   *
   * Note: Exception filters in WebSocket context are executed for side effects
   * (logging, metrics, etc.) but cannot modify the response. All registered
   * filters are executed in order (method filters before class filters), and
   * the final response is always the serialized exception.
   *
   * This differs from HTTP exception filters which can send custom responses
   * directly. In WebSocket, the response must be serialized and returned to
   * the caller for transmission.
   *
   * @param exception - The exception that was thrown
   * @param host - The arguments host
   * @returns The error response to send to the client
   */
  async catch(exception: Error, host: WsArgumentsHost): Promise<unknown> {
    const filters = this.getFilters(host.instance, host.methodName);

    if (filters.length > 0) {
      this.logger.debug(`Executing ${filters.length} exception filter(s) for ${host.methodName}`);

      // Execute all filters for side effects (logging, metrics, etc.)
      // Filters cannot modify the response in WebSocket context
      for (const filter of filters) {
        try {
          const filterInstance = this.instantiateFilter(filter);
          const argumentsHost = this.createArgumentsHost(host);
          await filterInstance.catch(exception, argumentsHost);
        } catch (error) {
          // Filter instantiation or execution threw an error, log and continue to next filter
          const filterName = typeof filter === 'function' ? filter.name : filter.constructor.name;
          this.logger.error(
            `Exception filter ${filterName} threw an error: ${this.formatError(error)}`
          );
        }
      }
    }

    // Return serialized exception response
    return this.serializeException(exception);
  }

  /**
   * Gets exception filters from method and class metadata
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of filter types or instances
   */
  private getFilters(
    instance: object,
    methodName: string
  ): (Type<ExceptionFilter> | ExceptionFilter)[] {
    const classFilters: (Type<ExceptionFilter> | ExceptionFilter)[] =
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, instance.constructor) || [];

    const methodFilters: (Type<ExceptionFilter> | ExceptionFilter)[] =
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, instance.constructor, methodName) || [];

    // Method filters execute before class filters
    return [...methodFilters, ...classFilters];
  }

  /**
   * Resolves a filter to an instance
   * @param filter - The filter type or instance
   * @returns Filter instance
   * @throws Error if filter class cannot be resolved from DI container
   */
  private instantiateFilter(filter: Type<ExceptionFilter> | ExceptionFilter): ExceptionFilter {
    // If it's already an instance, return it directly
    if (typeof filter !== 'function') {
      return filter;
    }

    // It's a class, resolve from DI container
    try {
      return this.moduleRef.get(filter);
    } catch (error) {
      throw new Error(
        `Cannot instantiate filter ${filter.name}. Ensure it is registered as a provider in your module.`,
        { cause: error }
      );
    }
  }

  /**
   * Creates an ArgumentsHost for exception filters
   * @param host - The WebSocket arguments host
   * @returns ArgumentsHost
   */
  private createArgumentsHost(host: WsArgumentsHost): ArgumentsHost {
    const args = [host.client, host.data];

    return {
      getArgs: <T extends unknown[] = unknown[]>() => args as T,
      getArgByIndex: <T = unknown>(index: number): T => args[index] as T,
      switchToRpc: () => ({
        getContext: () => host.client,
        getData: () => host.data,
      }),
      switchToHttp: () => {
        throw new Error('HTTP context not available in WebSocket');
      },
      switchToWs: () => ({
        getClient: () => host.client,
        getData: () => host.data,
        getPattern: () => host.methodName,
      }),
      getType: () => 'ws' as const,
    } as ArgumentsHost;
  }

  /**
   * Serializes an exception to send to the client
   * @param exception - The exception
   * @returns Serialized error
   */
  private serializeException(exception: Error): unknown {
    if (exception instanceof WsException) {
      return exception.getError();
    }

    // Handle NestJS HttpException (e.g., ForbiddenException, UnauthorizedException)
    if (exception instanceof HttpException) {
      return exception.getResponse();
    }

    // For generic errors, log details server-side but return generic message to client
    this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);

    return {
      error: 'Internal server error',
      message: 'An unexpected error occurred',
    };
  }

  /**
   * Formats error for logging
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
