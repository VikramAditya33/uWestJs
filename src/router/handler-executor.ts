import { Logger } from '@nestjs/common';
import 'reflect-metadata';
import {
  PARAM_ARGS_METADATA,
  ParamMetadata,
  ParamType,
} from '../decorators/message-body.decorator';

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
 * Executes message handlers with proper parameter injection
 */
export class HandlerExecutor {
  private readonly logger = new Logger(HandlerExecutor.name);

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

      const paramMetadata = this.getParameterMetadata(instance, methodName);
      const args = this.buildArguments(paramMetadata, client, data);

      this.logger.debug(`Executing handler ${methodName} with ${args.length} parameters`);

      const result = await method.apply(instance, args);

      return { success: true, response: result };
    } catch (error) {
      this.logger.error(`Error executing handler ${methodName}: ${this.formatError(error)}`);
      return { success: false, error: this.toError(error) };
    }
  }

  /**
   * Gets parameter metadata for a method
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of parameter metadata sorted by index
   */
  private getParameterMetadata(instance: object, methodName: string): ParamMetadata[] {
    const metadata: ParamMetadata[] =
      Reflect.getMetadata(PARAM_ARGS_METADATA, instance.constructor, methodName) || [];

    return metadata.sort((a, b) => a.index - b.index);
  }

  /**
   * Builds the arguments array for handler execution
   * @param paramMetadata - Parameter metadata
   * @param client - The WebSocket client
   * @param data - The message data
   * @returns Array of arguments in correct order
   */
  private buildArguments(
    paramMetadata: ParamMetadata[],
    client: unknown,
    data: unknown
  ): unknown[] {
    if (paramMetadata.length === 0) {
      return [client, data];
    }

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
        if (param.data && data && typeof data === 'object') {
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
