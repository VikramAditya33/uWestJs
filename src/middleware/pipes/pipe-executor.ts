import { ArgumentMetadata, Logger, PipeTransform, Type } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { PARAM_ARGS_METADATA } from '../../decorators/param-decorator.utils';
import { DefaultModuleRef, ModuleRef } from '../module-ref';

/**
 * Parameter metadata with pipe information
 */
export interface ParamWithPipes {
  /**
   * Parameter index
   */
  index: number;

  /**
   * Parameter type (for metadata)
   */
  type: string;

  /**
   * Parameter data/property name
   */
  data?: string;

  /**
   * Pipes to apply to this parameter
   */
  pipes: Type<PipeTransform>[];
}

/**
 * Executes pipes for parameter transformation and validation
 */
export class PipeExecutor {
  private readonly logger = new Logger(PipeExecutor.name);
  private readonly moduleRef: ModuleRef;

  constructor(moduleRef?: ModuleRef) {
    this.moduleRef = moduleRef || new DefaultModuleRef();
  }

  /**
   * Transforms parameters through their pipes
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @param args - The arguments array
   * @returns Promise resolving to transformed arguments
   * @throws Error if any pipe throws an exception
   */
  async transformParameters(
    instance: object,
    methodName: string,
    args: unknown[]
  ): Promise<unknown[]> {
    const paramPipes = this.getParameterPipes(instance, methodName);

    if (paramPipes.length === 0) {
      return args;
    }

    this.logger.debug(`Transforming ${paramPipes.length} parameter(s) for ${methodName}`);

    const transformedArgs = [...args];

    for (const paramPipe of paramPipes) {
      if (paramPipe.index >= args.length) {
        continue;
      }

      const value = transformedArgs[paramPipe.index];
      const metadata: ArgumentMetadata = {
        type: 'custom',
        metatype: undefined,
        data: paramPipe.data,
      };

      transformedArgs[paramPipe.index] = await this.applyPipes(value, metadata, paramPipe.pipes);
    }

    return transformedArgs;
  }

  /**
   * Applies pipes to a single value
   * @param value - The value to transform
   * @param metadata - Argument metadata
   * @param pipes - Pipes to apply
   * @returns Promise resolving to transformed value
   */
  private async applyPipes(
    value: unknown,
    metadata: ArgumentMetadata,
    pipes: Type<PipeTransform>[]
  ): Promise<unknown> {
    let transformedValue = value;

    for (const pipeType of pipes) {
      const pipe = this.instantiatePipe(pipeType);

      try {
        transformedValue = await pipe.transform(transformedValue, metadata);
      } catch (error) {
        this.logger.error(`Pipe ${pipeType.name} threw an exception: ${this.formatError(error)}`);
        throw error;
      }
    }

    return transformedValue;
  }

  /**
   * Gets parameter pipes from method and class metadata
   * @param instance - The gateway instance
   * @param methodName - The method name
   * @returns Array of parameters with their pipes
   */
  private getParameterPipes(instance: object, methodName: string): ParamWithPipes[] {
    const prototype = Object.getPrototypeOf(instance);

    const classPipes: Type<PipeTransform>[] =
      Reflect.getMetadata(PIPES_METADATA, instance.constructor) || [];

    const methodPipes: Type<PipeTransform>[] =
      Reflect.getMetadata(PIPES_METADATA, instance.constructor, methodName) || [];

    const paramPipes: Map<number, Type<PipeTransform>[]> =
      Reflect.getMetadata(`${PIPES_METADATA}:params`, instance.constructor, methodName) ||
      new Map();

    const paramMetadata: Array<{ index: number; type: string; data?: string }> =
      Reflect.getMetadata(PARAM_ARGS_METADATA, prototype, methodName) || [];

    const allPipes = [...classPipes, ...methodPipes];
    const result: ParamWithPipes[] = [];

    // Build a Map for O(1) parameter metadata lookup
    const paramMetaMap = new Map(paramMetadata.map((p) => [p.index, p]));

    // Build a combined map of all parameter indices that need pipe processing
    const paramIndices = new Set<number>([
      ...paramMetadata.map((p) => p.index),
      ...paramPipes.keys(),
    ]);

    paramIndices.forEach((index) => {
      const paramMeta = paramMetaMap.get(index);
      const paramSpecificPipes = paramPipes.get(index) || [];
      const combinedPipes = [...allPipes, ...paramSpecificPipes];

      if (combinedPipes.length > 0) {
        result.push({
          index,
          type: paramMeta?.type || 'custom',
          data: paramMeta?.data,
          pipes: combinedPipes,
        });
      }
    });

    return result;
  }

  /**
   * Instantiates a pipe using the DI container
   * @param pipeType - The pipe type
   * @returns Pipe instance
   * @throws Error if pipe cannot be resolved from DI container
   */
  private instantiatePipe(pipeType: Type<PipeTransform>): PipeTransform {
    try {
      return this.moduleRef.get(pipeType);
    } catch (error) {
      this.logger.error(
        `Failed to resolve pipe ${pipeType.name} from DI container: ${this.formatError(error)}`
      );
      throw new Error(
        `Cannot instantiate pipe ${pipeType.name}. Ensure it is registered as a provider in your module.`,
        { cause: error }
      );
    }
  }

  /**
   * Formats error for logging
   */
  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
