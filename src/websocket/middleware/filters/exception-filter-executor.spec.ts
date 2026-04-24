import { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ExceptionFilterExecutor, WsArgumentsHost } from './exception-filter-executor';
import { UseFilters } from './use-filters.decorator';
import { WsException } from '../../exceptions/ws-exception';

/**
 * Helper to create a basic host object
 */
function createHost(
  instance: object,
  client = {},
  data = {},
  methodName = 'handleMessage'
): WsArgumentsHost {
  return {
    instance,
    methodName,
    client,
    data,
  };
}

describe('ExceptionFilterExecutor', () => {
  let executor: ExceptionFilterExecutor;

  beforeEach(() => {
    executor = new ExceptionFilterExecutor();
  });

  describe('default exception handling', () => {
    it('should handle WsException with message only', async () => {
      class TestGateway {}
      const host = createHost(new TestGateway());

      const result = await executor.catch(new WsException('Test error'), host);

      expect(result).toEqual({
        message: 'Test error',
      });
    });

    it('should handle WsException with object message', async () => {
      class TestGateway {}
      const host = createHost(new TestGateway());

      const errorObj = { code: 'ERR_001', details: 'Something went wrong' };
      const result = await executor.catch(new WsException(errorObj), host);

      expect(result).toEqual({
        message: errorObj,
      });
    });

    it('should handle WsException with circular reference in message', async () => {
      class TestGateway {}
      const host = createHost(new TestGateway());

      // Create object with circular reference
      const circularObj: Record<string, unknown> = { name: 'test' };
      circularObj.self = circularObj;

      const exception = new WsException(circularObj);
      const result = await executor.catch(exception, host);

      // Should return the original object (circular ref preserved)
      expect(result).toEqual({
        message: circularObj,
      });
      expect((result as { message: Record<string, unknown> }).message.self).toBe(
        (result as { message: Record<string, unknown> }).message
      );
    });

    it('should handle WsException with error code', async () => {
      class TestGateway {}
      const host = createHost(new TestGateway());

      const result = await executor.catch(new WsException('Test error', 'TEST_ERROR'), host);

      expect(result).toEqual({
        message: 'Test error',
        error: 'TEST_ERROR',
      });
    });

    it('should handle generic Error', async () => {
      class TestGateway {}
      const host = createHost(new TestGateway());

      const result = await executor.catch(new Error('Generic error'), host);

      expect(result).toEqual({
        error: 'Internal server error',
        message: 'An unexpected error occurred',
      });
    });
  });

  describe('custom filters', () => {
    it('should execute custom exception filter', async () => {
      let filterCalled = false;

      class CustomFilter implements ExceptionFilter {
        catch(): void {
          filterCalled = true;
        }
      }

      class TestGateway {
        @UseFilters(CustomFilter)
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      expect(filterCalled).toBe(true);
    });

    it('should pass ArgumentsHost to filter', async () => {
      let receivedHost: ArgumentsHost | null = null;

      class ContextCheckFilter implements ExceptionFilter {
        catch(_exception: Error, host: ArgumentsHost): void {
          receivedHost = host;
        }
      }

      class TestGateway {
        @UseFilters(ContextCheckFilter)
        handleMessage() {}
      }

      const client = { id: 'test-client' };
      const data = { message: 'hello' };
      const host = createHost(new TestGateway(), client, data);

      await executor.catch(new Error('Test'), host);

      expect(receivedHost).not.toBeNull();
      expect(receivedHost!.getType()).toBe('ws');
      expect(receivedHost!.switchToWs().getClient()).toBe(client);
      expect(receivedHost!.switchToWs().getData()).toBe(data);
    });

    it('should provide correct getArgs and getArgByIndex', async () => {
      let receivedHost: ArgumentsHost | null = null;

      class ArgsCheckFilter implements ExceptionFilter {
        catch(_exception: Error, host: ArgumentsHost): void {
          receivedHost = host;
        }
      }

      class TestGateway {
        @UseFilters(ArgsCheckFilter)
        handleMessage() {}
      }

      const client = { id: 'test-client' };
      const data = { message: 'hello' };
      const host = createHost(new TestGateway(), client, data);

      await executor.catch(new Error('Test'), host);

      expect(receivedHost).not.toBeNull();

      // getArgs should return array with 2 elements
      const args = receivedHost!.getArgs();
      expect(args).toHaveLength(2);
      expect(args[0]).toBe(client);
      expect(args[1]).toBe(data);

      // getArgByIndex should return correct values
      expect(receivedHost!.getArgByIndex(0)).toBe(client);
      expect(receivedHost!.getArgByIndex(1)).toBe(data);

      // Out-of-range indices should return undefined
      expect(receivedHost!.getArgByIndex(2)).toBeUndefined();
      expect(receivedHost!.getArgByIndex(-1)).toBeUndefined();
      expect(receivedHost!.getArgByIndex(999)).toBeUndefined();
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
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      expect(executionOrder).toEqual(['first', 'second']);
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
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

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
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      expect(executionOrder).toEqual(['throwing', 'working']);
    });

    it('should await async filters', async () => {
      const executionOrder: string[] = [];

      class AsyncFilter implements ExceptionFilter {
        async catch(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push('async');
        }
      }

      class SyncFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('sync');
        }
      }

      class TestGateway {
        @UseFilters(AsyncFilter, SyncFilter)
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      // Async filter should complete before sync filter executes
      expect(executionOrder).toEqual(['async', 'sync']);
    });

    it('should catch errors from async filters', async () => {
      const executionOrder: string[] = [];

      class AsyncThrowingFilter implements ExceptionFilter {
        async catch(): Promise<void> {
          executionOrder.push('async-throwing');
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Async filter error');
        }
      }

      class WorkingFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('working');
        }
      }

      class TestGateway {
        @UseFilters(AsyncThrowingFilter, WorkingFilter)
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      // Both filters should execute despite async error
      expect(executionOrder).toEqual(['async-throwing', 'working']);
    });

    it('should continue to next filter if instantiation fails', async () => {
      const executionOrder: string[] = [];

      // Filter with constructor that throws an error
      class FailingFilter implements ExceptionFilter {
        constructor() {
          throw new Error('Constructor failed');
        }
        catch(): void {
          executionOrder.push('failing');
        }
      }

      class WorkingFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('working');
        }
      }

      class TestGateway {
        @UseFilters(FailingFilter, WorkingFilter)
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      await executor.catch(new Error('Test'), host);

      // Working filter should still execute even though FailingFilter failed to instantiate
      expect(executionOrder).toEqual(['working']);
    });
  });

  describe('filter instances', () => {
    it('should execute filter instance', async () => {
      const mockCatch = jest.fn();
      const filterInstance: ExceptionFilter = {
        catch: mockCatch,
      };

      @UseFilters(filterInstance)
      class TestGateway {
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      const error = new Error('Test');

      await executor.catch(error, host);

      expect(mockCatch).toHaveBeenCalledWith(error, expect.any(Object));
    });

    it('should execute mixed filter classes and instances', async () => {
      const mockCatch1 = jest.fn();
      const mockCatch2 = jest.fn();

      class FilterClass implements ExceptionFilter {
        catch = mockCatch1;
      }

      const filterInstance: ExceptionFilter = {
        catch: mockCatch2,
      };

      @UseFilters(FilterClass, filterInstance)
      class TestGateway {
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      const error = new Error('Test');

      await executor.catch(error, host);

      expect(mockCatch1).toHaveBeenCalledWith(error, expect.any(Object));
      expect(mockCatch2).toHaveBeenCalledWith(error, expect.any(Object));
    });

    it('should handle filter instance that throws', async () => {
      const filterInstance: ExceptionFilter = {
        catch: () => {
          throw new Error('Filter error');
        },
      };

      @UseFilters(filterInstance)
      class TestGateway {
        handleMessage() {}
      }

      const host = createHost(new TestGateway());
      const error = new Error('Test');

      const result = await executor.catch(error, host);

      expect(result).toEqual({
        error: 'Internal server error',
        message: 'An unexpected error occurred',
      });
    });
  });
});
