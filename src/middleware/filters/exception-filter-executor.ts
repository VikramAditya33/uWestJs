import { ArgumentsHost, ExceptionFilter, Logger, Type } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { WsException } from '../../exceptions/ws-exception';
import { DefaultModuleRef, ModuleRef } from '../module-ref';
import { WsContext } from '../ws-context';

/**
 * WebSocket arguments host for exception filters
 * Extends the base WsContext with filter-specific functionality
 */
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
   * @param exception - The exception that was thrown
   * @param host - The arguments host
   * @returns The error response to send to the client
   */
  async catch(exception: Error, host: WsArgumentsHost): Promise<unknown> {
    const filters = this.getFilters(host.instance, host.methodName);

    if (filters.length > 0) {
      this.logger.debug(`Executing ${filters.length} exception filter(s) for ${host.methodName}`);

      // Execute all filters (they all get a chance to handle the exception)
      for (const filterType of filters) {
        const filter = this.instantiateFilter(filterType);

        try {
          const argumentsHost = this.createArgumentsHost(host);
          await filter.catch(exception, argumentsHost);
        } catch (error) {
          // Filter threw an error, log and continue to next filter
          this.logger.error(
            `Exception filter ${filterType.name} threw an error: ${this.formatError(error)}`
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
   * @returns Array of filter types
   */
  private getFilters(instance: object, methodName: string): Type<ExceptionFilter>[] {
    const classFilters: Type<ExceptionFilter>[] =
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, instance.constructor) || [];

    const methodFilters: Type<ExceptionFilter>[] =
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, instance.constructor, methodName) || [];

    // Method filters execute before class filters
    return [...methodFilters, ...classFilters];
  }

  /**
   * Instantiates an exception filter using the DI container
   * @param filterType - The filter type
   * @returns Filter instance
   */
  private instantiateFilter(filterType: Type<ExceptionFilter>): ExceptionFilter {
    return this.moduleRef.get(filterType);
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
