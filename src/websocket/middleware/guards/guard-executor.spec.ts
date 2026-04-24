import { CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { GuardExecutor, WsExecutionContext } from './guard-executor';
import { UseGuards } from './use-guards.decorator';

/**
 * Helper to create a basic execution context
 */
function createContext(
  instance: object,
  client = {},
  data = {},
  methodName = 'handleMessage'
): WsExecutionContext {
  return {
    instance,
    methodName,
    client,
    data,
  };
}

describe('GuardExecutor', () => {
  let executor: GuardExecutor;

  beforeEach(() => {
    executor = new GuardExecutor();
  });

  describe('guard execution', () => {
    it('should return true when no guards are present', async () => {
      class TestGateway {}
      const context = createContext(new TestGateway());

      const result = await executor.executeGuards(context);

      expect(result).toBe(true);
    });

    it('should execute guards and return their result', async () => {
      class PassingGuard implements CanActivate {
        canActivate(): boolean {
          return true;
        }
      }

      class FailingGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class TestGateway {
        @UseGuards(PassingGuard)
        handlePassing() {}

        @UseGuards(FailingGuard)
        handleFailing() {}
      }

      const gateway = new TestGateway();

      const passingResult = await executor.executeGuards(
        createContext(gateway, {}, {}, 'handlePassing')
      );
      expect(passingResult).toBe(true);

      const failingResult = await executor.executeGuards(
        createContext(gateway, {}, {}, 'handleFailing')
      );
      expect(failingResult).toBe(false);
    });

    it('should support async guards', async () => {
      class AsyncGuard implements CanActivate {
        async canActivate(): Promise<boolean> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return true;
        }
      }

      class TestGateway {
        @UseGuards(AsyncGuard)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());
      const result = await executor.executeGuards(context);

      expect(result).toBe(true);
    });

    it('should throw error when guard throws exception', async () => {
      class ThrowingGuard implements CanActivate {
        canActivate(): boolean {
          throw new UnauthorizedException('Access denied');
        }
      }

      class TestGateway {
        @UseGuards(ThrowingGuard)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      await expect(executor.executeGuards(context)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('multiple guards', () => {
    it('should execute multiple guards in order', async () => {
      const executionOrder: string[] = [];

      class FirstGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('first');
          return true;
        }
      }

      class SecondGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('second');
          return true;
        }
      }

      class TestGateway {
        @UseGuards(FirstGuard, SecondGuard)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());
      await executor.executeGuards(context);

      expect(executionOrder).toEqual(['first', 'second']);
    });

    it('should stop execution when first guard fails', async () => {
      const executionOrder: string[] = [];

      class FirstGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('first');
          return false;
        }
      }

      class SecondGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('second');
          return true;
        }
      }

      class TestGateway {
        @UseGuards(FirstGuard, SecondGuard)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());
      const result = await executor.executeGuards(context);

      expect(result).toBe(false);
      expect(executionOrder).toEqual(['first']);
    });

    it('should execute class guards before method guards', async () => {
      const executionOrder: string[] = [];

      class ClassGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('class');
          return true;
        }
      }

      class MethodGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('method');
          return true;
        }
      }

      @UseGuards(ClassGuard)
      class TestGateway {
        @UseGuards(MethodGuard)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());
      await executor.executeGuards(context);

      expect(executionOrder).toEqual(['class', 'method']);
    });
  });

  describe('execution context', () => {
    it('should provide full execution context to guards', async () => {
      let receivedContext: ExecutionContext | null = null;
      let wsContext: ReturnType<ExecutionContext['switchToWs']> | null = null;

      class ContextCheckGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          receivedContext = context;
          wsContext = context.switchToWs();
          return true;
        }
      }

      class TestGateway {
        @UseGuards(ContextCheckGuard)
        handleMessage() {}
      }

      const client = { id: 'test-client' };
      const data = { message: 'hello' };
      const context = createContext(new TestGateway(), client, data);

      await executor.executeGuards(context);

      // Check ExecutionContext
      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.getType()).toBe('ws');
      expect(receivedContext!.getClass()).toBe(TestGateway);
      expect(receivedContext!.getArgs()).toEqual([client, data]);

      // Check WsContext
      expect(wsContext).not.toBeNull();
      expect(wsContext!.getClient()).toBe(client);
      expect(wsContext!.getData()).toBe(data);
      expect(wsContext!.getPattern()).toBe('handleMessage');
    });

    it('should provide correct getArgByIndex for valid and invalid indices', async () => {
      let receivedContext: ExecutionContext | null = null;

      class ArgIndexCheckGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          receivedContext = context;
          return true;
        }
      }

      class TestGateway {
        @UseGuards(ArgIndexCheckGuard)
        handleMessage() {}
      }

      const client = { id: 'test-client' };
      const data = { message: 'hello' };
      const context = createContext(new TestGateway(), client, data);

      await executor.executeGuards(context);

      expect(receivedContext).not.toBeNull();

      // Valid indices
      expect(receivedContext!.getArgByIndex(0)).toBe(client);
      expect(receivedContext!.getArgByIndex(1)).toBe(data);

      // Out-of-bounds indices should return undefined
      expect(receivedContext!.getArgByIndex(2)).toBeUndefined();
      expect(receivedContext!.getArgByIndex(-1)).toBeUndefined();
      expect(receivedContext!.getArgByIndex(999)).toBeUndefined();
    });
  });

  describe('guard instances', () => {
    it('should execute guard instance', async () => {
      const mockCanActivate = jest.fn().mockReturnValue(true);
      const guardInstance: CanActivate = {
        canActivate: mockCanActivate,
      };

      class TestGateway {
        @UseGuards(guardInstance)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      const result = await executor.executeGuards(context);

      expect(result).toBe(true);
      expect(mockCanActivate).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should execute mixed guard classes and instances', async () => {
      const mockCanActivate1 = jest.fn().mockReturnValue(true);
      const mockCanActivate2 = jest.fn().mockReturnValue(true);

      class GuardClass implements CanActivate {
        canActivate = mockCanActivate1;
      }

      const guardInstance: CanActivate = {
        canActivate: mockCanActivate2,
      };

      class TestGateway {
        @UseGuards(GuardClass, guardInstance)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      const result = await executor.executeGuards(context);

      expect(result).toBe(true);
      expect(mockCanActivate1).toHaveBeenCalled();
      expect(mockCanActivate2).toHaveBeenCalled();
    });

    it('should deny access when guard instance returns false', async () => {
      const guardInstance: CanActivate = {
        canActivate: () => false,
      };

      class TestGateway {
        @UseGuards(guardInstance)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      const result = await executor.executeGuards(context);

      expect(result).toBe(false);
    });

    it('should handle guard instance that throws', async () => {
      const guardInstance: CanActivate = {
        canActivate: () => {
          throw new Error('Guard error');
        },
      };

      class TestGateway {
        @UseGuards(guardInstance)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      await expect(executor.executeGuards(context)).rejects.toThrow('Guard error');
    });

    it('should support Observable return from guard instance', async () => {
      const guardInstance: CanActivate = {
        canActivate: () => of(true),
      };

      class TestGateway {
        @UseGuards(guardInstance)
        handleMessage() {}
      }

      const context = createContext(new TestGateway());

      const result = await executor.executeGuards(context);

      expect(result).toBe(true);
    });
  });
});
