import { CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UseGuards } from './use-guards.decorator';
import { HandlerExecutor } from '../../routing/handler-executor';
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
 * Integration tests for guards with real handler execution
 */
describe('Guards Integration', () => {
  let executor: HandlerExecutor;

  beforeEach(() => {
    executor = new HandlerExecutor();
  });

  describe('authentication and authorization', () => {
    class AuthGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const client = context.switchToWs().getClient() as { authenticated?: boolean };
        return client.authenticated === true;
      }
    }

    class RoleGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const client = context.switchToWs().getClient() as { role?: string };
        return client.role === 'admin';
      }
    }

    it('should allow or deny based on authentication', async () => {
      class TestGateway {
        @UseGuards(AuthGuard)
        handleMessage(data: unknown) {
          return { success: true, data };
        }
      }

      const gateway = new TestGateway();

      // Authenticated client should pass
      const authResult = await executeHandler(
        executor,
        gateway,
        'handleMessage',
        { authenticated: true },
        { message: 'hello' }
      );
      expect(authResult.success).toBe(true);
      expect(authResult.response).toEqual({ success: true, data: { message: 'hello' } });

      // Unauthenticated client should be denied
      const unauthResult = await executeHandler(
        executor,
        gateway,
        'handleMessage',
        { authenticated: false },
        { message: 'hello' }
      );
      expect(unauthResult.success).toBe(false);
      expect(unauthResult.error?.message).toBe('Forbidden resource');
      expect(unauthResult.response).toBeDefined(); // Guard denials now go through exception filters
    });

    it('should allow or deny based on role', async () => {
      class TestGateway {
        @UseGuards(RoleGuard)
        handleAdminAction(data: unknown) {
          return { action: 'admin', data };
        }
      }

      const gateway = new TestGateway();

      // Admin should pass
      const adminResult = await executeHandler(
        executor,
        gateway,
        'handleAdminAction',
        { role: 'admin' },
        { action: 'delete' }
      );
      expect(adminResult.success).toBe(true);
      expect(adminResult.response).toEqual({ action: 'admin', data: { action: 'delete' } });

      // Non-admin should be denied
      const userResult = await executeHandler(
        executor,
        gateway,
        'handleAdminAction',
        { role: 'user' },
        { action: 'delete' }
      );
      expect(userResult.success).toBe(false);
      expect(userResult.response).toBeDefined(); // Guard denials now go through exception filters
    });
  });

  describe('data validation guard', () => {
    class DataValidationGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const data = context.switchToWs().getData() as { token?: string };
        if (!data.token) {
          throw new UnauthorizedException('Token required');
        }
        return true;
      }
    }

    it('should validate data and throw exception if invalid', async () => {
      class TestGateway {
        @UseGuards(DataValidationGuard)
        handleSecure(data: unknown) {
          return { secure: true, data };
        }
      }

      const gateway = new TestGateway();

      // Valid data should pass
      const validResult = await executeHandler(
        executor,
        gateway,
        'handleSecure',
        {},
        { token: 'valid-token' }
      );
      expect(validResult.success).toBe(true);

      // Invalid data should throw exception
      const invalidResult = await executeHandler(
        executor,
        gateway,
        'handleSecure',
        {},
        { message: 'no token' }
      );
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.error).toBeInstanceOf(UnauthorizedException);
      expect(invalidResult.response).toBeDefined(); // Guard denials now go through exception filters
    });
  });

  describe('class and method guards', () => {
    it('should execute guards in correct order', async () => {
      const executionOrder: string[] = [];

      class TrackingClassGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('class');
          return true;
        }
      }

      class TrackingMethodGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('method');
          return true;
        }
      }

      @UseGuards(TrackingClassGuard)
      class TestGateway {
        @UseGuards(TrackingMethodGuard)
        handleMessage(data: unknown) {
          executionOrder.push('handler');
          return data;
        }
      }

      await executeHandler(executor, new TestGateway(), 'handleMessage', {}, { test: true });

      expect(executionOrder).toEqual(['class', 'method', 'handler']);
    });

    it('should not execute handler if class guard fails', async () => {
      let handlerExecuted = false;

      class FailingClassGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class PassingMethodGuard implements CanActivate {
        canActivate(): boolean {
          return true;
        }
      }

      @UseGuards(FailingClassGuard)
      class TestGateway {
        @UseGuards(PassingMethodGuard)
        handleMessage() {
          handlerExecuted = true;
          return 'success';
        }
      }

      await executeHandler(executor, new TestGateway(), 'handleMessage', {}, {});

      expect(handlerExecuted).toBe(false);
    });
  });

  describe('async guards', () => {
    it('should support async guard execution', async () => {
      class AsyncAuthGuard implements CanActivate {
        async canActivate(context: ExecutionContext): Promise<boolean> {
          const client = context.switchToWs().getClient() as { token?: string };

          // Simulate async token validation
          await new Promise((resolve) => setTimeout(resolve, 10));

          return client.token === 'valid';
        }
      }

      class TestGateway {
        @UseGuards(AsyncAuthGuard)
        handleMessage(data: unknown) {
          return { authenticated: true, data };
        }
      }

      const gateway = new TestGateway();

      const validResult = await executeHandler(
        executor,
        gateway,
        'handleMessage',
        { token: 'valid' },
        { test: true }
      );
      expect(validResult.success).toBe(true);

      const invalidResult = await executeHandler(
        executor,
        gateway,
        'handleMessage',
        { token: 'invalid' },
        { test: true }
      );
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.response).toBeDefined(); // Guard denials now go through exception filters
    });
  });
});
