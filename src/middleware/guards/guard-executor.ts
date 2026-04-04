import { CanActivate, ExecutionContext, Logger, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { DefaultModuleRef, ModuleRef } from '../module-ref';
import { WsContext } from '../ws-context';

/**
 * Execution context for WebSocket guards
 * Extends the base WsContext with guard-specific functionality
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WsExecutionContext extends WsContext {}

/**
 * Executes guards before handler execution
 */
export class GuardExecutor {
  private readonly logger = new Logger(GuardExecutor.name);
  private readonly moduleRef: ModuleRef;

  /**
   * Creates a guard executor
   * @param moduleRef - Optional module reference for DI
   */
  constructor(moduleRef?: ModuleRef) {
    this.moduleRef = moduleRef || new DefaultModuleRef();
  }

  /**
   * Executes all guards for a handler
   * @param context - The execution context
   * @returns Promise resolving to true if all guards pass, false otherwise
   * @throws Error if any guard throws an exception
   */
  async executeGuards(context: WsExecutionContext): Promise<boolean> {
    const guards = this.getGuards(context.instance, context.methodName);

    if (guards.length === 0) {
      return true;
    }

    this.logger.debug(`Executing ${guards.length} guard(s) for ${context.methodName}`);

    for (const guard of guards) {
      const guardInstance = this.instantiateGuard(guard);
      const executionContext = this.createExecutionContext(context);

      try {
        const result = await guardInstance.canActivate(executionContext);

        if (!result) {
          this.logger.debug(`Guard ${guard.name} denied access for ${context.methodName}`);
          return false;
        }
      } catch (error) {
        this.logger.error(`Guard ${guard.name} threw an exception: ${this.formatError(error)}`);
        throw error;
      }
    }

    return true;
  }

  /**
   * Gets guards from method and class metadata
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of guard types
   */
  private getGuards(instance: object, methodName: string): Type<CanActivate>[] {
    const classGuards: Type<CanActivate>[] =
      Reflect.getMetadata(GUARDS_METADATA, instance.constructor) || [];

    const methodGuards: Type<CanActivate>[] =
      Reflect.getMetadata(GUARDS_METADATA, instance.constructor, methodName) || [];

    // Class guards execute before method guards
    return [...classGuards, ...methodGuards];
  }

  /**
   * Instantiates a guard using the DI container
   * @param guardType - The guard type
   * @returns Guard instance
   * @throws Error if guard cannot be resolved from DI container
   */
  private instantiateGuard(guardType: Type<CanActivate>): CanActivate {
    try {
      return this.moduleRef.get(guardType);
    } catch (error) {
      this.logger.error(
        `Failed to resolve guard ${guardType.name} from DI container: ${this.formatError(error)}`
      );
      throw new Error(
        `Cannot instantiate guard ${guardType.name}. Ensure it is registered as a provider in your module.`,
        { cause: error }
      );
    }
  }

  /**
   * Creates an ExecutionContext for guards
   * @param context - The WebSocket execution context
   * @returns ExecutionContext
   */
  private createExecutionContext(context: WsExecutionContext): ExecutionContext {
    // Create a minimal ExecutionContext implementation
    // This provides guards with access to the request context
    return {
      getClass: () => context.instance.constructor as Type<unknown>,
      getHandler: () => {
        const method = (context.instance as Record<string, unknown>)[context.methodName];
        if (typeof method !== 'function') {
          throw new Error(`Handler method '${context.methodName}' not found on instance`);
        }
        return method as (...args: unknown[]) => unknown;
      },
      getArgs: () => [context.client, context.data],
      getArgByIndex: (index: number) => {
        const args = [context.client, context.data];
        return args[index];
      },
      switchToRpc: () => ({
        getContext: () => context.client,
        getData: () => context.data,
      }),
      switchToHttp: () => {
        throw new Error('HTTP context not available in WebSocket');
      },
      switchToWs: () => ({
        getClient: () => context.client,
        getData: () => context.data,
        getPattern: () => context.methodName,
      }),
      getType: () => 'ws' as const,
    } as ExecutionContext;
  }

  /**
   * Formats error for logging
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
