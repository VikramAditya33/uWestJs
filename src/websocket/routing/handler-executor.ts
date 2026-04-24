import { ForbiddenException, Logger } from '@nestjs/common';
import 'reflect-metadata';
import { PARAM_ARGS_METADATA, ParamType } from '../decorators';
import type { ParamMetadata } from '../decorators/param-decorator.utils';
import { GuardExecutor, WsExecutionContext } from '../middleware/guards';
import { PipeExecutor } from '../middleware/pipes';
import { ExceptionFilterExecutor, WsArgumentsHost } from '../middleware/filters';
import { ModuleRef } from '../../shared/di';

/**
 * Result of executing a handler
 */
export interface ExecutionResult {
  /**
   * Whether the handler executed successfully
   */
  success: boolean;

  /**
   * The return value from the handler (if any)
   */
  response?: unknown;

  /**
   * Error that occurred during execution (if any)
   */
  error?: Error;
}

/**
 * Options for configuring HandlerExecutor
 */
export interface HandlerExecutorOptions {
  /**
   * Module reference for DI support in guards, pipes, and filters
   */
  moduleRef?: ModuleRef;

  /**
   * Custom guard executor (primarily for testing)
   */
  guardExecutor?: GuardExecutor;

  /**
   * Custom pipe executor (primarily for testing)
   */
  pipeExecutor?: PipeExecutor;

  /**
   * Custom exception filter executor (primarily for testing)
   */
  filterExecutor?: ExceptionFilterExecutor;
}

/**
 * Executes message handlers with proper parameter injection
 *
 * Supports dependency injection for guards, pipes, and filters when a ModuleRef is provided.
 * Without a ModuleRef, guards/pipes/filters are instantiated directly and cannot have
 * constructor dependencies.
 */
export class HandlerExecutor {
  private readonly logger = new Logger(HandlerExecutor.name);
  private readonly guardExecutor: GuardExecutor;
  private readonly pipeExecutor: PipeExecutor;
  private readonly filterExecutor: ExceptionFilterExecutor;

  /**
   * Creates a handler executor
   * @param options - Configuration options
   */
  constructor(options: HandlerExecutorOptions = {}) {
    const { moduleRef, guardExecutor, pipeExecutor, filterExecutor } = options;
    this.guardExecutor = guardExecutor ?? new GuardExecutor(moduleRef);
    this.pipeExecutor = pipeExecutor ?? new PipeExecutor(moduleRef);
    this.filterExecutor = filterExecutor ?? new ExceptionFilterExecutor(moduleRef);
  }

  /**
   * Executes a handler method with parameter injection
   * @param instance - The gateway instance
   * @param methodName - The method name to execute
   * @param client - The WebSocket client
   * @param data - The message data
   * @returns Promise resolving to the execution result
   */
  async execute(
    instance: object,
    methodName: string,
    client: unknown,
    data: unknown
  ): Promise<ExecutionResult> {
    try {
      const method = (instance as Record<string, unknown>)[methodName];

      if (typeof method !== 'function') {
        throw new Error(`Method ${methodName} not found on gateway instance`);
      }

      // Execute guards before handler
      const context: WsExecutionContext = {
        instance,
        methodName,
        client,
        data,
      };

      const guardsPassed = await this.guardExecutor.executeGuards(context);

      if (!guardsPassed) {
        this.logger.debug(`Guards denied access for ${methodName}`);
        const forbiddenError = new ForbiddenException('Forbidden resource');
        const host: WsArgumentsHost = {
          instance,
          methodName,
          client,
          data,
        };
        const errorResponse = await this.filterExecutor.catch(forbiddenError, host);
        return {
          success: false,
          error: forbiddenError,
          response: errorResponse,
        };
      }

      const paramMetadata = this.getParameterMetadata(instance, methodName);
      let args = this.buildArguments(paramMetadata, client, data);

      // Execute pipes on parameters
      args = await this.pipeExecutor.transformParameters(instance, methodName, args);

      this.logger.debug(`Executing handler ${methodName} with ${args.length} parameters`);

      const result = await method.apply(instance, args);

      return { success: true, response: result };
    } catch (error) {
      this.logger.error(`Error executing handler ${methodName}: ${this.formatError(error)}`);

      // Convert error once to avoid duplicate conversion
      const err = this.toError(error);

      // Execute exception filters
      const host: WsArgumentsHost = {
        instance,
        methodName,
        client,
        data,
      };

      const errorResponse = await this.filterExecutor.catch(err, host);

      return {
        success: false,
        error: err,
        response: errorResponse,
      };
    }
  }

  /**
   * Gets parameter metadata for a method
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of parameter metadata sorted by index
   */
  private getParameterMetadata(instance: object, methodName: string): ParamMetadata[] {
    // Read metadata from prototype (where decorators store it)
    const metadata: ParamMetadata[] =
      Reflect.getMetadata(PARAM_ARGS_METADATA, Object.getPrototypeOf(instance), methodName) || [];

    // Create a copy before sorting to avoid mutating the original metadata
    return [...metadata].sort((a, b) => a.index - b.index);
  }

  /**
   * Builds the arguments array for handler execution
   *
   * Behavior:
   * - No decorators: Returns [client, data] as fallback for undecorated handlers
   * - With decorators: Creates array with decorated parameters at their specified indices
   * - Partial decorators: Undecorated parameter positions will be undefined
   *
   * @param paramMetadata - Parameter metadata
   * @param client - The WebSocket client
   * @param data - The message data
   * @returns Array of arguments in correct order
   *
   * @example
   * ```typescript
   * // No decorators - fallback to [client, data]
   * handleMessage(client, data) { }
   *
   * // All decorated - explicit parameter injection
   * handleMessage(@ConnectedSocket() client, @MessageBody() data) { }
   *
   * // Partial decorators - undecorated positions are undefined
   * handleMessage(@MessageBody() data, someParam) { } // someParam will be undefined
   * ```
   */
  private buildArguments(
    paramMetadata: ParamMetadata[],
    client: unknown,
    data: unknown
  ): unknown[] {
    // Fallback for handlers without parameter decorators
    // Assumes signature: (client, data) => void
    if (paramMetadata.length === 0) {
      return [client, data];
    }

    // Build arguments array based on decorator metadata
    // Note: Undecorated parameter positions will remain undefined
    const maxIndex = Math.max(...paramMetadata.map((p) => p.index));
    const args: unknown[] = new Array(maxIndex + 1);

    for (const param of paramMetadata) {
      args[param.index] = this.resolveParameter(param, client, data);
    }

    return args;
  }

  /**
   * Resolves a single parameter value based on its metadata
   * @param param - Parameter metadata
   * @param client - The WebSocket client
   * @param data - The message data
   * @returns The resolved parameter value
   */
  private resolveParameter(param: ParamMetadata, client: unknown, data: unknown): unknown {
    switch (param.type) {
      case ParamType.CONNECTED_SOCKET:
        return client;

      case ParamType.MESSAGE_BODY:
      case ParamType.PAYLOAD:
        // Extract property from data if specified
        // Note: Arrays are excluded from property extraction to avoid silent undefined returns
        if (param.data && data && typeof data === 'object' && !Array.isArray(data)) {
          return (data as Record<string, unknown>)[param.data];
        }
        return data;

      default:
        this.logger.warn(`Unknown parameter type: ${param.type}`);
        return undefined;
    }
  }

  /**
   * Checks if a method has parameter decorators
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns True if the method has parameter decorators
   */
  hasParameterDecorators(instance: object, methodName: string): boolean {
    return this.getParameterMetadata(instance, methodName).length > 0;
  }

  /**
   * Formats error for logging
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Converts unknown error to Error instance
   */
  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
