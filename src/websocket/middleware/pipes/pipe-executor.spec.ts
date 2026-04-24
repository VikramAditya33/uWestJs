import { ArgumentMetadata, BadRequestException, PipeTransform, Type } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import { PipeExecutor } from './pipe-executor';
import { PARAM_ARGS_METADATA, ParamType } from '../../decorators';

/**
 * Helper to apply MessageBody decorator metadata
 */
function applyMessageBodyDecorator(
  target: object,
  methodName: string,
  paramIndex: number,
  data?: string
): void {
  // Check if target IS the prototype (not an instance)
  const isPrototype = target.constructor?.prototype === target;
  const metadataTarget = isPrototype ? target : Object.getPrototypeOf(target);

  const existingParams = Reflect.getMetadata(PARAM_ARGS_METADATA, metadataTarget, methodName) || [];
  existingParams.push({ index: paramIndex, type: ParamType.MESSAGE_BODY, data });
  Reflect.defineMetadata(PARAM_ARGS_METADATA, existingParams, metadataTarget, methodName);
}

/**
 * Helper to apply pipe metadata to a parameter
 */
function applyPipeToParam(
  target: object,
  methodName: string,
  paramIndex: number,
  ...pipes: (Type<PipeTransform> | PipeTransform)[]
): void {
  const existingPipes: Map<number, (Type<PipeTransform> | PipeTransform)[]> =
    Reflect.getMetadata(`${PIPES_METADATA}:params`, target.constructor, methodName) || new Map();

  const paramPipes = existingPipes.get(paramIndex) || [];
  paramPipes.push(...pipes);
  existingPipes.set(paramIndex, paramPipes);

  Reflect.defineMetadata(`${PIPES_METADATA}:params`, existingPipes, target.constructor, methodName);
}

// Reusable pipe implementations
class UpperCasePipe implements PipeTransform {
  transform(value: string): string {
    return typeof value === 'string' ? value.toUpperCase() : value;
  }
}

class TrimPipe implements PipeTransform {
  transform(value: string): string {
    return typeof value === 'string' ? value.trim() : value;
  }
}

class ParseIntPipe implements PipeTransform {
  transform(value: string): number {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new BadRequestException('Invalid number');
    }
    return parsed;
  }
}

describe('PipeExecutor', () => {
  let executor: PipeExecutor;

  beforeEach(() => {
    executor = new PipeExecutor();
  });

  describe('basic transformation', () => {
    it('should return args unchanged when no pipes are present', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const args = [{ test: 'data' }];
      const result = await executor.transformParameters(new TestGateway(), 'handleMessage', args);

      expect(result).toEqual(args);
    });

    it('should transform parameter with single and multiple pipes', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      class AddPrefixPipe implements PipeTransform {
        transform(value: string): string {
          return `PREFIX_${value}`;
        }
      }

      const gateway = new TestGateway();

      // Single pipe
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, UpperCasePipe);
      const singleResult = await executor.transformParameters(gateway, 'handleMessage', ['hello']);
      expect(singleResult).toEqual(['HELLO']);

      // Multiple pipes in order
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, AddPrefixPipe);
      const multiResult = await executor.transformParameters(gateway, 'handleMessage', ['hello']);
      expect(multiResult).toEqual(['PREFIX_HELLO']);
    });

    it('should support async pipes', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      class AsyncPipe implements PipeTransform {
        async transform(value: string): Promise<string> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return value.toUpperCase();
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, AsyncPipe);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['hello']);

      expect(result).toEqual(['HELLO']);
    });

    it('should throw error when pipe throws exception', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      class ValidationPipe implements PipeTransform {
        transform(value: unknown): unknown {
          if (!value) {
            throw new BadRequestException('Value is required');
          }
          return value;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, ValidationPipe);

      await expect(executor.transformParameters(gateway, 'handleMessage', [null])).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe('multiple parameters', () => {
    it('should transform multiple parameters independently', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, UpperCasePipe);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 1, ParseIntPipe);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['hello', '42']);

      expect(result).toEqual(['HELLO', 42]);
    });

    it('should skip transformation for parameters beyond args length', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, UpperCasePipe);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 1, UpperCasePipe);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['hello']);

      expect(result).toEqual(['HELLO']);
    });
  });

  describe('class and method level pipes', () => {
    it('should apply method-level pipes to parameters', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      applyMessageBodyDecorator(TestGateway.prototype, 'handleMessage', 0);
      Reflect.defineMetadata(PIPES_METADATA, [TrimPipe], TestGateway, 'handleMessage');

      const gateway = new TestGateway();
      const result = await executor.transformParameters(gateway, 'handleMessage', ['  hello  ']);

      expect(result).toEqual(['hello']);
    });

    it('should apply class-level pipes to parameters', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const gateway = new TestGateway();
      applyMessageBodyDecorator(TestGateway.prototype, 'handleMessage', 0);
      Reflect.defineMetadata(PIPES_METADATA, [TrimPipe], TestGateway);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['  hello  ']);

      expect(result).toEqual(['hello']);
    });

    it('should combine class, method, and parameter pipes in order', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const executionOrder: string[] = [];

      class ClassPipe implements PipeTransform {
        transform(value: string): string {
          executionOrder.push('class');
          return value;
        }
      }

      class MethodPipe implements PipeTransform {
        transform(value: string): string {
          executionOrder.push('method');
          return value;
        }
      }

      class ParamPipe implements PipeTransform {
        transform(value: string): string {
          executionOrder.push('param');
          return value;
        }
      }

      const gateway = new TestGateway();
      Reflect.defineMetadata(PIPES_METADATA, [ClassPipe], TestGateway);
      Reflect.defineMetadata(PIPES_METADATA, [MethodPipe], TestGateway, 'handleMessage');
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, ParamPipe);

      await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(executionOrder).toEqual(['class', 'method', 'param']);
    });
  });

  describe('metadata and type transformation', () => {
    it('should pass argument metadata to pipes', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      let receivedMetadata: ArgumentMetadata | null = null;

      class MetadataCheckPipe implements PipeTransform {
        transform(value: unknown, metadata: ArgumentMetadata): unknown {
          receivedMetadata = metadata;
          return value;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, MetadataCheckPipe);

      await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(receivedMetadata).not.toBeNull();
      expect(receivedMetadata!.type).toBe('custom');
    });

    it('should handle pipes that return different types', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, ParseIntPipe);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['123']);

      expect(result).toEqual([123]);
      expect(typeof result[0]).toBe('number');
    });

    it('should reuse pipe instances from DI container', async () => {
      class TestGateway {
        handleMessage(data: unknown) {
          return data;
        }
      }

      let instanceCount = 0;

      class CountingPipe implements PipeTransform {
        constructor() {
          instanceCount++;
        }
        transform(value: unknown): unknown {
          return value;
        }
      }

      const gateway = new TestGateway();
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, CountingPipe);

      // Execute multiple times
      await executor.transformParameters(gateway, 'handleMessage', ['test1']);
      await executor.transformParameters(gateway, 'handleMessage', ['test2']);
      await executor.transformParameters(gateway, 'handleMessage', ['test3']);

      // Should only create one instance (cached by DI container)
      expect(instanceCount).toBe(1);
    });
  });

  describe('pipe instances', () => {
    it('should execute pipe instance', async () => {
      const mockTransform = jest.fn((value) => value.toUpperCase());
      const pipeInstance: PipeTransform = {
        transform: mockTransform,
      };

      class TestGateway {
        handleMessage(data: string) {
          return data;
        }
      }

      const gateway = new TestGateway();

      // Manually apply metadata
      applyMessageBodyDecorator(gateway, 'handleMessage', 0);
      applyPipeToParam(gateway, 'handleMessage', 0, pipeInstance as any);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(result).toEqual(['TEST']);
      expect(mockTransform).toHaveBeenCalledWith('test', expect.any(Object));
    });

    it('should execute mixed pipe classes and instances', async () => {
      const mockTransform1 = jest.fn((value) => value.toUpperCase());
      const mockTransform2 = jest.fn((value) => value + '!');

      class PipeClass implements PipeTransform {
        transform = mockTransform1;
      }

      const pipeInstance: PipeTransform = {
        transform: mockTransform2,
      };

      class TestGateway {
        handleMessage(data: string) {
          return data;
        }
      }

      const gateway = new TestGateway();

      // Manually apply metadata
      applyMessageBodyDecorator(gateway, 'handleMessage', 0);
      applyPipeToParam(gateway, 'handleMessage', 0, PipeClass, pipeInstance as any);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(result).toEqual(['TEST!']);
      expect(mockTransform1).toHaveBeenCalled();
      expect(mockTransform2).toHaveBeenCalled();
    });

    it('should handle pipe instance that throws', async () => {
      const pipeInstance: PipeTransform = {
        transform: () => {
          throw new Error('Pipe error');
        },
      };

      class TestGateway {
        handleMessage(data: string) {
          return data;
        }
      }

      const gateway = new TestGateway();

      // Manually apply metadata
      applyMessageBodyDecorator(gateway, 'handleMessage', 0);
      applyPipeToParam(gateway, 'handleMessage', 0, pipeInstance as any);

      await expect(
        executor.transformParameters(gateway, 'handleMessage', ['test'])
      ).rejects.toThrow('Pipe error');
    });

    it('should execute async pipe instance', async () => {
      const pipeInstance: PipeTransform = {
        transform: async (value) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return value.toUpperCase();
        },
      };

      class TestGateway {
        handleMessage(data: string) {
          return data;
        }
      }

      const gateway = new TestGateway();

      // Manually apply metadata
      applyMessageBodyDecorator(gateway, 'handleMessage', 0);
      applyPipeToParam(gateway, 'handleMessage', 0, pipeInstance as any);

      const result = await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(result).toEqual(['TEST']);
    });

    it('should apply method-level pipe instance to all parameters', async () => {
      const mockTransform = jest.fn((value) => value.toUpperCase());
      const pipeInstance: PipeTransform = {
        transform: mockTransform,
      };

      class TestGateway {
        handleMessage(data: string) {
          return data;
        }
      }

      const gateway = new TestGateway();

      // Manually apply metadata
      applyMessageBodyDecorator(gateway, 'handleMessage', 0);

      // Apply method-level pipe
      Reflect.defineMetadata(PIPES_METADATA, [pipeInstance], gateway.constructor, 'handleMessage');

      await executor.transformParameters(gateway, 'handleMessage', ['test']);

      expect(mockTransform).toHaveBeenCalledWith('test', expect.any(Object));
    });
  });
});
