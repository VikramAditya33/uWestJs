import { CanActivate, ExecutionContext, Logger, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { isObservable, lastValueFrom } from 'rxjs';
import 'reflect-metadata';
import { DefaultModuleRef, ModuleRef } from '../../../shared/di';
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
        let result = guardInstance.canActivate(executionContext);
        if (isObservable(result)) {
          result = await lastValueFrom(result);
        } else {
          result = await result;
        }

        if (!result) {
          const guardName = typeof guard === 'function' ? guard.name : guard.constructor.name;
          this.logger.debug(`Guard ${guardName} denied access for ${context.methodName}`);
          return false;
        }
      } catch (error) {
        const guardName = typeof guard === 'function' ? guard.name : guard.constructor.name;
        this.logger.error(`Guard ${guardName} threw an exception: ${this.formatError(error)}`);
        throw error;
      }
    }

    return true;
  }

  /**
   * Gets guards from method and class metadata
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of guard types or instances
   */
  private getGuards(instance: object, methodName: string): (Type<CanActivate> | CanActivate)[] {
    const classGuards: (Type<CanActivate> | CanActivate)[] =
      Reflect.getMetadata(GUARDS_METADATA, instance.constructor) || [];

    const methodGuards: (Type<CanActivate> | CanActivate)[] =
      Reflect.getMetadata(GUARDS_METADATA, instance.constructor, methodName) || [];

    // Class guards execute before method guards
    return [...classGuards, ...methodGuards];
  }

  /**
   * Resolves a guard to an instance
   * @param guard - The guard type or instance
   * @returns Guard instance
   * @throws Error if guard class cannot be resolved from DI container
   */
  private instantiateGuard(guard: Type<CanActivate> | CanActivate): CanActivate {
    // If it's already an instance, return it directly
    if (typeof guard !== 'function') {
      return guard;
    }

    // It's a class, resolve from DI container
    try {
      return this.moduleRef.get(guard);
    } catch (error) {
      this.logger.error(
        `Failed to resolve guard ${guard.name} from DI container: ${this.formatError(error)}`
      );
      throw new Error(
        `Cannot instantiate guard ${guard.name}. Ensure it is registered as a provider in your module.`,
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
