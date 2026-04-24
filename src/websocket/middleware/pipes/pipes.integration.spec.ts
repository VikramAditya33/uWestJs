import { ArgumentMetadata, BadRequestException, PipeTransform, Type } from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import { HandlerExecutor } from '../../routing/handler-executor';
import { PARAM_ARGS_METADATA, ParamType } from '../../decorators';

// Reusable pipe implementations
class TrimPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return typeof value === 'string' ? value.trim() : value;
  }
}

class ParseIntPipe implements PipeTransform {
  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new BadRequestException(`${metadata.data || 'Value'} must be a number`);
    }
    return parsed;
  }
}

class RequiredPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (value === null || value === undefined || value === '') {
      throw new BadRequestException('Value is required');
    }
    return value;
  }
}

/**
 * Helper to execute a handler with pipes
 */
async function executeHandler(
  executor: HandlerExecutor,
  gatewayClass: Type<any>,
  methodName: string,
  paramPipes: Type<PipeTransform>[],
  data: unknown,
  classPipes?: Type<PipeTransform>[],
  methodPipes?: Type<PipeTransform>[]
) {
  const gateway = new gatewayClass();

  // Apply parameter decorator metadata (check for duplicates)
  const existingParams =
    Reflect.getMetadata(PARAM_ARGS_METADATA, gatewayClass.prototype, methodName) || [];

  const alreadyExists = existingParams.some(
    (p: { index: number; type: ParamType }) => p.index === 0 && p.type === ParamType.MESSAGE_BODY
  );

  if (!alreadyExists) {
    const newParams = [...existingParams, { index: 0, type: ParamType.MESSAGE_BODY }];
    Reflect.defineMetadata(PARAM_ARGS_METADATA, newParams, gatewayClass.prototype, methodName);
  }

  // Apply parameter pipes (create entry even if empty so method/class pipes can be applied)
  // Create a fresh copy to avoid metadata pollution between test runs
  const existingPipesMap: Map<number, Type<PipeTransform>[]> =
    Reflect.getMetadata(`${PIPES_METADATA}:params`, gatewayClass, methodName) || new Map();
  const existingPipes = new Map(existingPipesMap);

  if (paramPipes.length > 0 || methodPipes || classPipes) {
    // Set param pipes (empty array if no param-specific pipes)
    existingPipes.set(0, paramPipes);
    Reflect.defineMetadata(`${PIPES_METADATA}:params`, existingPipes, gatewayClass, methodName);
  }

  // Apply class-level pipes
  if (classPipes) {
    Reflect.defineMetadata(PIPES_METADATA, classPipes, gatewayClass);
  }

  // Apply method-level pipes
  if (methodPipes) {
    Reflect.defineMetadata(PIPES_METADATA, methodPipes, gatewayClass, methodName);
  }

  return executor.execute(gateway, methodName, {}, data);
}

/**
 * Integration tests for pipes with real handler execution
 */
describe('Pipes Integration', () => {
  let executor: HandlerExecutor;

  beforeEach(() => {
    executor = new HandlerExecutor();
  });

  describe('data transformation', () => {
    it('should transform string to number and reject invalid input', async () => {
      class TestGateway {
        handleMessage(num: number) {
          return { result: num * 2, type: typeof num };
        }
      }

      const validResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [ParseIntPipe],
        '42'
      );
      expect(validResult.success).toBe(true);
      expect(validResult.response).toEqual({ result: 84, type: 'number' });

      const invalidResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [ParseIntPipe],
        'invalid'
      );
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.error).toBeInstanceOf(BadRequestException);
    });
  });

  describe('data validation', () => {
    it('should pass valid data and reject empty data', async () => {
      class TestGateway {
        handleMessage(data: string) {
          return { valid: true, data };
        }
      }

      const validResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [RequiredPipe],
        'hello'
      );
      expect(validResult.success).toBe(true);
      expect(validResult.response).toEqual({ valid: true, data: 'hello' });

      const invalidResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [RequiredPipe],
        ''
      );
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.error).toBeInstanceOf(BadRequestException);
    });
  });

  describe('data sanitization', () => {
    it('should sanitize input data', async () => {
      class LowerCasePipe implements PipeTransform {
        transform(value: unknown): unknown {
          return typeof value === 'string' ? value.toLowerCase() : value;
        }
      }

      class TestGateway {
        handleMessage(text: string) {
          return { sanitized: text };
        }
      }

      const result = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [TrimPipe, LowerCasePipe],
        '  HELLO  '
      );
      expect(result.success).toBe(true);
      expect(result.response).toEqual({ sanitized: 'hello' });
    });
  });

  describe('object transformation', () => {
    it('should add default values to object', async () => {
      class DefaultValuesPipe implements PipeTransform {
        transform(value: Record<string, unknown>): Record<string, unknown> {
          return { status: 'active', timestamp: Date.now(), ...value };
        }
      }

      class TestGateway {
        handleMessage(data: Record<string, unknown>) {
          return data;
        }
      }

      const result = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [DefaultValuesPipe],
        { name: 'test' }
      );
      expect(result.success).toBe(true);
      expect(result.response).toMatchObject({ name: 'test', status: 'active' });
      expect((result.response as Record<string, unknown>).timestamp).toBeDefined();
    });
  });

  describe('method-level pipes', () => {
    it('should apply pipe to all parameters', async () => {
      class TestGateway {
        handleMessage(data: string) {
          return { data };
        }
      }

      const result = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [],
        '  hello  ',
        undefined,
        [TrimPipe]
      );
      expect(result.success).toBe(true);
      expect(result.response).toEqual({ data: 'hello' });
    });
  });

  describe('class-level pipes', () => {
    it('should apply pipe to all handlers', async () => {
      class TestGateway {
        handleMessage(data: string) {
          return { data };
        }

        handleOther(text: string) {
          return { text };
        }
      }

      const result1 = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [],
        '  hello  ',
        [TrimPipe]
      );
      expect(result1.success).toBe(true);
      expect(result1.response).toEqual({ data: 'hello' });

      const result2 = await executeHandler(executor, TestGateway, 'handleOther', [], '  world  ', [
        TrimPipe,
      ]);
      expect(result2.success).toBe(true);
      expect(result2.response).toEqual({ text: 'world' });
    });
  });

  describe('pipe execution order', () => {
    it('should execute pipes in correct order', async () => {
      const executionLog: string[] = [];

      class FirstPipe implements PipeTransform {
        transform(value: string): string {
          executionLog.push('first');
          return value;
        }
      }

      class SecondPipe implements PipeTransform {
        transform(value: string): string {
          executionLog.push('second');
          return value;
        }
      }

      class ThirdPipe implements PipeTransform {
        transform(value: string): string {
          executionLog.push('third');
          return value;
        }
      }

      class TestGateway {
        handleMessage(data: string) {
          executionLog.push('handler');
          return data;
        }
      }

      await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [ThirdPipe],
        'test',
        [FirstPipe],
        [SecondPipe]
      );
      expect(executionLog).toEqual(['first', 'second', 'third', 'handler']);
    });
  });

  describe('async pipes', () => {
    it('should support async pipe execution', async () => {
      class AsyncValidationPipe implements PipeTransform {
        async transform(value: string): Promise<string> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (value === 'forbidden') {
            throw new BadRequestException('Value is forbidden');
          }
          return value;
        }
      }

      class TestGateway {
        handleMessage(data: string) {
          return { validated: true, data };
        }
      }

      const validResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [AsyncValidationPipe],
        'allowed'
      );
      expect(validResult.success).toBe(true);
      expect(validResult.response).toEqual({ validated: true, data: 'allowed' });

      const invalidResult = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [AsyncValidationPipe],
        'forbidden'
      );
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.error).toBeInstanceOf(BadRequestException);
    });
  });

  describe('complex transformation pipeline', () => {
    it('should execute complex transformation pipeline', async () => {
      class ParseJsonPipe implements PipeTransform {
        transform(value: string): unknown {
          try {
            return JSON.parse(value);
          } catch {
            throw new BadRequestException('Invalid JSON');
          }
        }
      }

      class ValidateObjectPipe implements PipeTransform {
        transform(value: unknown): unknown {
          if (typeof value !== 'object' || value === null) {
            throw new BadRequestException('Must be an object');
          }
          return value;
        }
      }

      class TestGateway {
        handleMessage(data: Record<string, unknown>) {
          return { processed: true, data };
        }
      }

      const result = await executeHandler(
        executor,
        TestGateway,
        'handleMessage',
        [TrimPipe, ParseJsonPipe, ValidateObjectPipe],
        '  {"name": "test"}  '
      );
      expect(result.success).toBe(true);
      expect(result.response).toEqual({ processed: true, data: { name: 'test' } });
    });
  });
});
