import { Type } from '@nestjs/common';
import { ModuleRef as NestModuleRef } from '@nestjs/core';

/**
 * Module reference for dependency injection
 * Provides a simple interface for resolving instances from a DI container
 */
export interface ModuleRef {
  /**
   * Gets an instance from the DI container
   * @param typeOrToken - The type or token to resolve
   * @returns The resolved instance
   */
  get<T>(typeOrToken: Type<T>): T;
}

/**
 * Default module reference that creates and caches new instances
 * Used when no external DI container is provided
 *
 * Note: This implementation only supports classes with parameterless constructors.
 * Guards, pipes, and filters with constructor dependencies require NestJsModuleRef
 * that integrates with NestJS's DI container.
 */
export class DefaultModuleRef implements ModuleRef {
  private readonly instances = new Map<Type<unknown>, unknown>();

  get<T>(typeOrToken: Type<T>): T {
    if (!this.instances.has(typeOrToken)) {
      try {
        this.instances.set(typeOrToken, new typeOrToken());
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to instantiate ${typeOrToken.name}: ${errorMessage}. ` +
            `Classes with constructor dependencies require NestJsModuleRef. ` +
            `Pass NestJsModuleRef.create(moduleRef) to UwsAdapter options: ` +
            `new UwsAdapter(app, { moduleRef: NestJsModuleRef.create(moduleRef) })`,
          { cause: error }
        );
      }
    }
    return this.instances.get(typeOrToken) as T;
  }
}

/**
 * NestJS module reference adapter
 * Wraps NestJS's ModuleRef to provide dependency injection support
 *
 * Use this when you need guards, pipes, or filters with constructor dependencies.
 *
 * @example
 * ```typescript
 * import { ModuleRef } from '@nestjs/core';
 * import { NestJsModuleRef } from 'uwestjs';
 *
 * class MyGateway {
 *   constructor(private moduleRef: ModuleRef) {}
 *
 *   afterInit() {
 *     const adapter = new UwsAdapter({
 *       moduleRef: NestJsModuleRef.create(this.moduleRef)
 *     });
 *   }
 * }
 * ```
 */
export class NestJsModuleRef implements ModuleRef {
  private constructor(private readonly nestModuleRef: NestModuleRef) {}

  /**
   * Creates a NestJsModuleRef from a NestJS ModuleRef
   * @param nestModuleRef - The NestJS ModuleRef instance
   * @returns A new NestJsModuleRef instance
   * @throws Error if nestModuleRef is null or undefined
   */
  static create(nestModuleRef: NestModuleRef): NestJsModuleRef {
    if (!nestModuleRef || typeof nestModuleRef.get !== 'function') {
      throw new Error(
        'NestJsModuleRef.create() requires a valid NestJS ModuleRef instance. ' +
          'Pass the ModuleRef obtained from your NestJS application.'
      );
    }
    return new NestJsModuleRef(nestModuleRef);
  }

  get<T>(typeOrToken: Type<T>): T {
    try {
      return this.nestModuleRef.get(typeOrToken, { strict: false });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve ${typeOrToken.name} from NestJS DI container: ${errorMessage}. ` +
          `Ensure the class is provided in a module that is imported by your application.`,
        { cause: error }
      );
    }
  }
}
