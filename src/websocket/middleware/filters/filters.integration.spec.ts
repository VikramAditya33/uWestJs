import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { UseFilters } from './use-filters.decorator';
import { HandlerExecutor } from '../../routing/handler-executor';
import { PARAM_ARGS_METADATA, ParamType } from '../../decorators';
import { WsException } from '../../exceptions/ws-exception';

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

  // Check if metadata already exists for this parameter to avoid accumulation
  const alreadyExists = existingParams.some(
    (p: { index: number; type: ParamType; data?: string }) =>
      p.index === paramIndex && p.type === ParamType.MESSAGE_BODY && p.data === data
  );

  if (alreadyExists) {
    return;
  }

  existingParams.push({ index: paramIndex, type: ParamType.MESSAGE_BODY, data });
  Reflect.defineMetadata(PARAM_ARGS_METADATA, existingParams, metadataTarget, methodName);
}

/**
 * Helper to execute a handler with a gateway
 */
async function executeHandler(
  executor: HandlerExecutor,
  gateway: object,
  methodName: string,
  client = {},
  data = {}
) {
  applyMessageBodyDecorator(Object.getPrototypeOf(gateway), methodName, 0);
  return executor.execute(gateway, methodName, client, data);
}

/**
 * Integration tests for exception filters with real handler execution
 */
describe('Exception Filters Integration', () => {
  let executor: HandlerExecutor;

  beforeEach(() => {
    executor = new HandlerExecutor();
  });

  describe('WsException handling', () => {
    it('should catch WsException with different formats', async () => {
      class TestGateway {
        throwSimple() {
          throw new WsException('Operation failed');
        }

        throwWithCode() {
          throw new WsException('Validation failed', 'VALIDATION_ERROR');
        }

        throwWithObject() {
          throw new WsException({ field: 'email', message: 'Invalid email' });
        }
      }

      const gateway = new TestGateway();

      // Simple message
      const result1 = await executeHandler(executor, gateway, 'throwSimple');
      expect(result1.success).toBe(false);
      expect(result1.error).toBeInstanceOf(WsException);

      // With error code
      const result2 = await executeHandler(executor, gateway, 'throwWithCode');
      expect(result2.success).toBe(false);
      expect((result2.error as WsException).error).toBe('VALIDATION_ERROR');

      // With object message
      const result3 = await executeHandler(executor, gateway, 'throwWithObject');
      expect(result3.success).toBe(false);
      expect(result3.error).toBeInstanceOf(WsException);
    });
  });

  describe('custom exception filters', () => {
    it('should execute custom filter and provide context', async () => {
      let filterExecuted = false;
      let caughtException: Error | null = null;
      let wsContext: ReturnType<ArgumentsHost['switchToWs']> | null = null;

      class LoggingFilter implements ExceptionFilter {
        catch(exception: Error, host: ArgumentsHost): void {
          filterExecuted = true;
          caughtException = exception;
          wsContext = host.switchToWs();
        }
      }

      class TestGateway {
        @UseFilters(LoggingFilter)
        handleMessage() {
          throw new Error('Test error');
        }
      }

      const client = { id: 'test-client' };
      const data = { message: 'hello' };
      const gateway = new TestGateway();

      await executeHandler(executor, gateway, 'handleMessage', client, data);

      expect(filterExecuted).toBe(true);
      expect(caughtException).not.toBeNull();
      expect(caughtException).toBeInstanceOf(Error);
      expect(caughtException!.message).toBe('Test error');
      expect(wsContext).not.toBeNull();
      expect(wsContext!.getClient()).toBe(client);
      expect(wsContext!.getData()).toBe(data);
    });

    it('should execute multiple filters in order', async () => {
      const executionOrder: string[] = [];

      class FirstFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('first');
        }
      }

      class SecondFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('second');
        }
      }

      class TestGateway {
        @UseFilters(FirstFilter, SecondFilter)
        handleMessage() {
          throw new Error('Test');
        }
      }

      await executeHandler(executor, new TestGateway(), 'handleMessage');

      expect(executionOrder).toEqual(['first', 'second']);
    });

    it('should apply class-level filter to all methods', async () => {
      let filterCallCount = 0;

      class GlobalFilter implements ExceptionFilter {
        catch(): void {
          filterCallCount++;
        }
      }

      @UseFilters(GlobalFilter)
      class TestGateway {
        handleMessage1() {
          throw new Error('Error 1');
        }

        handleMessage2() {
          throw new Error('Error 2');
        }
      }

      const gateway = new TestGateway();
      await executeHandler(executor, gateway, 'handleMessage1');
      await executeHandler(executor, gateway, 'handleMessage2');

      expect(filterCallCount).toBe(2);
    });

    it('should execute method filters before class filters', async () => {
      const executionOrder: string[] = [];

      class ClassFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('class');
        }
      }

      class MethodFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('method');
        }
      }

      @UseFilters(ClassFilter)
      class TestGateway {
        @UseFilters(MethodFilter)
        handleMessage() {
          throw new Error('Test');
        }
      }

      await executeHandler(executor, new TestGateway(), 'handleMessage');

      expect(executionOrder).toEqual(['method', 'class']);
    });

    it('should continue to next filter if one throws', async () => {
      const executionOrder: string[] = [];

      class ThrowingFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('throwing');
          throw new Error('Filter error');
        }
      }

      class WorkingFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('working');
        }
      }

      class TestGateway {
        @UseFilters(ThrowingFilter, WorkingFilter)
        handleMessage() {
          throw new Error('Handler error');
        }
      }

      await executeHandler(executor, new TestGateway(), 'handleMessage');

      expect(executionOrder).toEqual(['throwing', 'working']);
    });
  });

  describe('async error handling', () => {
    it('should catch errors from async handlers', async () => {
      let filterCalled = false;

      class AsyncFilter implements ExceptionFilter {
        catch(): void {
          filterCalled = true;
        }
      }

      class TestGateway {
        @UseFilters(AsyncFilter)
        async handleMessage() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Async error');
        }
      }

      const result = await executeHandler(executor, new TestGateway(), 'handleMessage');

      expect(result.success).toBe(false);
      expect(filterCalled).toBe(true);
    });
  });
});
