import { HandlerExecutor } from './handler-executor';
import { PARAM_ARGS_METADATA, ParamType } from '../decorators';
import {
  CanActivate,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  PipeTransform,
  Type,
  ExceptionFilter,
  ArgumentsHost,
} from '@nestjs/common';
import { PIPES_METADATA } from '@nestjs/common/constants';
import { UseGuards } from '../middleware/guards';
import { UseFilters } from '../middleware/filters';
import { WsException } from '../exceptions/ws-exception';
import 'reflect-metadata';

/**
 * Helper to apply parameter decorator metadata
 */
function applyParamDecorator(
  target: object,
  methodName: string,
  paramIndex: number,
  type: ParamType,
  data?: string
): void {
  // Check if target IS the prototype (not an instance)
  const isPrototype = target.constructor?.prototype === target;
  const metadataTarget = isPrototype ? target : Object.getPrototypeOf(target);

  const existingParams = Reflect.getMetadata(PARAM_ARGS_METADATA, metadataTarget, methodName) || [];

  // Check if metadata already exists for this parameter to avoid test pollution
  const alreadyExists = existingParams.some(
    (p: { index: number; type: ParamType; data?: string }) =>
      p.index === paramIndex && p.type === type && p.data === data
  );

  if (alreadyExists) {
    return;
  }

  existingParams.push({ index: paramIndex, type, data });
  Reflect.defineMetadata(PARAM_ARGS_METADATA, existingParams, metadataTarget, methodName);
}

/**
 * Helper to apply pipe metadata to a parameter
 */
function applyPipeToParam(
  target: object,
  methodName: string,
  paramIndex: number,
  ...pipes: Type<PipeTransform>[]
): void {
  const existingPipes: Map<number, Type<PipeTransform>[]> =
    Reflect.getMetadata(`${PIPES_METADATA}:params`, target.constructor, methodName) || new Map();

  const paramPipes = existingPipes.get(paramIndex) || [];

  // Only add pipes that don't already exist to avoid test pollution
  pipes.forEach((pipe) => {
    if (!paramPipes.includes(pipe)) {
      paramPipes.push(pipe);
    }
  });

  existingPipes.set(paramIndex, paramPipes);

  Reflect.defineMetadata(`${PIPES_METADATA}:params`, existingPipes, target.constructor, methodName);
}

/**
 * Helper to create test gateway with decorators
 */
function createGateway(
  handler: (...args: unknown[]) => unknown,
  decorators?: Array<{ index: number; type: ParamType; data?: string }>
) {
  class TestGateway {
    handleMessage(...args: unknown[]) {
      return handler(...args);
    }
  }

  if (decorators) {
    decorators.forEach((dec) => {
      applyParamDecorator(TestGateway.prototype, 'handleMessage', dec.index, dec.type, dec.data);
    });
  }

  return new TestGateway();
}

describe('HandlerExecutor', () => {
  let executor: HandlerExecutor;
  const mockClient = { id: 'client-123' };
  const mockData = { message: 'hello', text: 'hello world', user: 'vikram' };

  beforeEach(() => {
    executor = new HandlerExecutor();
  });

  describe('execute', () => {
    it('should execute handler without decorators using default (client, data) parameters', async () => {
      const gateway = createGateway((client, data) => ({ client, data }));

      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result).toEqual({
        success: true,
        response: { client: mockClient, data: mockData },
      });
    });

    it('should inject @MessageBody with optional property extraction', async () => {
      const fullGateway = createGateway(
        (data) => data,
        [{ index: 0, type: ParamType.MESSAGE_BODY }]
      );
      const fullResult = await executor.execute(fullGateway, 'handleMessage', {}, mockData);
      expect(fullResult).toEqual({ success: true, response: mockData });

      const propertyGateway = createGateway(
        (text) => text,
        [{ index: 0, type: ParamType.MESSAGE_BODY, data: 'text' }]
      );
      const propertyResult = await executor.execute(propertyGateway, 'handleMessage', {}, mockData);
      expect(propertyResult).toEqual({ success: true, response: 'hello world' });
    });

    it('should inject @ConnectedSocket parameter', async () => {
      const gateway = createGateway(
        (client) => client,
        [{ index: 0, type: ParamType.CONNECTED_SOCKET }]
      );

      const result = await executor.execute(gateway, 'handleMessage', mockClient, {});

      expect(result).toEqual({ success: true, response: mockClient });
    });

    it('should inject @Payload with optional property extraction', async () => {
      const fullGateway = createGateway((data) => data, [{ index: 0, type: ParamType.PAYLOAD }]);
      const fullResult = await executor.execute(fullGateway, 'handleMessage', {}, mockData);
      expect(fullResult).toEqual({ success: true, response: mockData });

      const propertyGateway = createGateway(
        (user) => user,
        [{ index: 0, type: ParamType.PAYLOAD, data: 'user' }]
      );
      const propertyResult = await executor.execute(propertyGateway, 'handleMessage', {}, mockData);
      expect(propertyResult).toEqual({ success: true, response: 'vikram' });
    });

    it('should return entire array when data is array with property extraction', async () => {
      const arrayData = ['item1', 'item2', 'item3'];
      const gateway = createGateway(
        (data) => data,
        [{ index: 0, type: ParamType.MESSAGE_BODY, data: 'items' }]
      );

      const result = await executor.execute(gateway, 'handleMessage', {}, arrayData);

      // Arrays are not subject to property extraction, return the whole array
      expect(result).toEqual({ success: true, response: arrayData });
    });

    it('should inject multiple parameters in correct order', async () => {
      const gateway = createGateway(
        (client, data) => ({ client, data }),
        [
          { index: 0, type: ParamType.CONNECTED_SOCKET },
          { index: 1, type: ParamType.MESSAGE_BODY },
        ]
      );

      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result).toEqual({
        success: true,
        response: { client: mockClient, data: mockData },
      });
    });

    it('should inject mixed decorators with property extraction', async () => {
      const gateway = createGateway(
        (client, text, user) => ({ client, text, user }),
        [
          { index: 0, type: ParamType.CONNECTED_SOCKET },
          { index: 1, type: ParamType.MESSAGE_BODY, data: 'text' },
          { index: 2, type: ParamType.PAYLOAD, data: 'user' },
        ]
      );

      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result).toEqual({
        success: true,
        response: { client: mockClient, text: 'hello world', user: 'vikram' },
      });
    });

    it('should handle async handlers and Promises', async () => {
      const asyncGateway = createGateway(
        async (data) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return data;
        },
        [{ index: 0, type: ParamType.MESSAGE_BODY }]
      );
      const asyncResult = await executor.execute(asyncGateway, 'handleMessage', {}, mockData);
      expect(asyncResult).toEqual({ success: true, response: mockData });

      const promiseGateway = createGateway(
        (data) => Promise.resolve(data),
        [{ index: 0, type: ParamType.MESSAGE_BODY }]
      );
      const promiseResult = await executor.execute(promiseGateway, 'handleMessage', {}, mockData);
      expect(promiseResult).toEqual({ success: true, response: mockData });
    });

    it('should handle handlers returning undefined or null', async () => {
      const undefinedGateway = createGateway(
        () => undefined,
        [{ index: 0, type: ParamType.MESSAGE_BODY }]
      );
      const undefinedResult = await executor.execute(undefinedGateway, 'handleMessage', {}, {});
      expect(undefinedResult).toEqual({ success: true, response: undefined });

      const nullGateway = createGateway(() => null, [{ index: 0, type: ParamType.MESSAGE_BODY }]);
      const nullResult = await executor.execute(nullGateway, 'handleMessage', {}, {});
      expect(nullResult).toEqual({ success: true, response: null });
    });

    it('should catch and return handler errors', async () => {
      const syncGateway = createGateway(() => {
        throw new Error('Handler error');
      }, [{ index: 0, type: ParamType.MESSAGE_BODY }]);
      const syncResult = await executor.execute(syncGateway, 'handleMessage', {}, {});
      expect(syncResult.success).toBe(false);
      expect(syncResult.error).toBeInstanceOf(Error);
      expect(syncResult.error?.message).toBe('Handler error');

      const asyncGateway = createGateway(async () => {
        throw new Error('Async error');
      }, [{ index: 0, type: ParamType.MESSAGE_BODY }]);
      const asyncResult = await executor.execute(asyncGateway, 'handleMessage', {}, {});
      expect(asyncResult.success).toBe(false);
      expect(asyncResult.error).toBeInstanceOf(Error);
      expect(asyncResult.error?.message).toBe('Async error');

      const nonErrorGateway = createGateway(() => {
        throw 'String error';
      }, [{ index: 0, type: ParamType.MESSAGE_BODY }]);
      const nonErrorResult = await executor.execute(nonErrorGateway, 'handleMessage', {}, {});
      expect(nonErrorResult.success).toBe(false);
      expect(nonErrorResult.error).toBeInstanceOf(Error);
      expect(nonErrorResult.error?.message).toBe('String error');
    });

    it('should return error when method not found', async () => {
      class TestGateway {}
      const gateway = new TestGateway();

      const result = await executor.execute(gateway, 'nonExistent', {}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain('not found');
    });

    it('should handle property extraction from non-object data', async () => {
      const gateway = createGateway(
        (text) => text,
        [{ index: 0, type: ParamType.MESSAGE_BODY, data: 'text' }]
      );

      const result = await executor.execute(gateway, 'handleMessage', {}, 'plain string');

      expect(result).toEqual({ success: true, response: 'plain string' });
    });
  });

  describe('hasParameterDecorators', () => {
    it('should return true when method has decorators', () => {
      const gateway = createGateway(() => undefined, [{ index: 0, type: ParamType.MESSAGE_BODY }]);

      expect(executor.hasParameterDecorators(gateway, 'handleMessage')).toBe(true);
    });

    it('should return false when method has no decorators', () => {
      const gateway = createGateway(() => undefined);

      expect(executor.hasParameterDecorators(gateway, 'handleMessage')).toBe(false);
    });
  });

  describe('guard integration', () => {
    it('should execute handler when guard passes', async () => {
      class PassingGuard implements CanActivate {
        canActivate(): boolean {
          return true;
        }
      }

      class TestGateway {
        @UseGuards(PassingGuard)
        handleMessage() {
          return 'success';
        }
      }

      const gateway = new TestGateway();
      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result).toEqual({ success: true, response: 'success' });
    });

    it('should return error when guard fails', async () => {
      class FailingGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class TestGateway {
        @UseGuards(FailingGuard)
        handleMessage() {
          return 'success';
        }
      }

      const gateway = new TestGateway();
      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(ForbiddenException);
      expect(result.error?.message).toBe('Forbidden resource');
      expect(result.response).toBeDefined(); // Guard denials now go through exception filters
    });

    it('should pass execution context to guards', async () => {
      let receivedContext: ExecutionContext | null = null;

      class ContextCheckGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          receivedContext = context;
          return true;
        }
      }

      class TestGateway {
        @UseGuards(ContextCheckGuard)
        handleMessage() {
          return 'success';
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(receivedContext).not.toBeNull();
      expect(receivedContext!.getType()).toBe('ws');
      expect(receivedContext!.switchToWs().getClient()).toBe(mockClient);
      expect(receivedContext!.switchToWs().getData()).toBe(mockData);
    });

    it('should propagate guard exceptions', async () => {
      class ThrowingGuard implements CanActivate {
        canActivate(): boolean {
          throw new Error('Guard exception');
        }
      }

      class TestGateway {
        @UseGuards(ThrowingGuard)
        handleMessage() {
          return 'success';
        }
      }

      const gateway = new TestGateway();
      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Guard exception');
    });

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
        handleMessage() {
          executionOrder.push('handler');
          return 'success';
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(executionOrder).toEqual(['first', 'second', 'handler']);
    });

    it('should not execute handler when guard fails', async () => {
      let handlerExecuted = false;

      class FailingGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class TestGateway {
        @UseGuards(FailingGuard)
        handleMessage() {
          handlerExecuted = true;
          return 'success';
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(handlerExecuted).toBe(false);
    });
  });

  describe('pipe integration', () => {
    it('should transform parameter with pipe', async () => {
      class UpperCasePipe implements PipeTransform {
        transform(value: string): string {
          return value.toUpperCase();
        }
      }

      class TestGateway {
        handleMessage(data: string) {
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, UpperCasePipe);

      const result = await executor.execute(gateway, 'handleMessage', mockClient, 'hello');

      expect(result.success).toBe(true);
      expect(result.response).toEqual({ data: 'HELLO' });
    });

    it('should execute multiple pipes in order', async () => {
      class TrimPipe implements PipeTransform {
        transform(value: string): string {
          return value.trim();
        }
      }

      class UpperCasePipe implements PipeTransform {
        transform(value: string): string {
          return value.toUpperCase();
        }
      }

      class TestGateway {
        handleMessage(data: string) {
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, TrimPipe, UpperCasePipe);

      const result = await executor.execute(gateway, 'handleMessage', mockClient, '  hello  ');

      expect(result.success).toBe(true);
      expect(result.response).toEqual({ data: 'HELLO' });
    });

    it('should propagate pipe exceptions', async () => {
      class ValidationPipe implements PipeTransform {
        transform(value: unknown): unknown {
          if (!value) {
            throw new BadRequestException('Value is required');
          }
          return value;
        }
      }

      class TestGateway {
        handleMessage(data: unknown) {
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, ValidationPipe);

      const result = await executor.execute(gateway, 'handleMessage', mockClient, null);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(BadRequestException);
    });

    it('should execute guards before pipes', async () => {
      const executionOrder: string[] = [];

      class TestGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('guard');
          return true;
        }
      }

      class TestPipe implements PipeTransform {
        transform(value: string): string {
          executionOrder.push('pipe');
          return value;
        }
      }

      class TestGateway {
        @UseGuards(TestGuard)
        handleMessage(data: string) {
          executionOrder.push('handler');
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, TestPipe);

      await executor.execute(gateway, 'handleMessage', mockClient, 'test');

      expect(executionOrder).toEqual(['guard', 'pipe', 'handler']);
    });

    it('should not execute pipes when guard fails', async () => {
      let pipeExecuted = false;

      class FailingGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class TestPipe implements PipeTransform {
        transform(value: string): string {
          pipeExecuted = true;
          return value;
        }
      }

      class TestGateway {
        @UseGuards(FailingGuard)
        handleMessage(data: string) {
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, TestPipe);

      await executor.execute(gateway, 'handleMessage', mockClient, 'test');

      expect(pipeExecuted).toBe(false);
    });

    it('should support async pipes', async () => {
      class AsyncPipe implements PipeTransform {
        async transform(value: string): Promise<string> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return value.toUpperCase();
        }
      }

      class TestGateway {
        handleMessage(data: string) {
          return { data };
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, AsyncPipe);

      const result = await executor.execute(gateway, 'handleMessage', mockClient, 'hello');

      expect(result.success).toBe(true);
      expect(result.response).toEqual({ data: 'HELLO' });
    });
  });

  describe('filter integration', () => {
    it('should catch handler exceptions', async () => {
      class TestGateway {
        handleMessage() {
          throw new Error('Handler error');
        }
      }

      const gateway = new TestGateway();
      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Handler error');
    });

    it('should execute exception filter on error', async () => {
      let filterCalled = false;

      class TestFilter implements ExceptionFilter {
        catch(): void {
          filterCalled = true;
        }
      }

      class TestGateway {
        @UseFilters(TestFilter)
        handleMessage() {
          throw new Error('Test error');
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(filterCalled).toBe(true);
    });

    it('should pass ArgumentsHost to filter', async () => {
      let receivedHost: ArgumentsHost | null = null;

      class ContextFilter implements ExceptionFilter {
        catch(exception: Error, host: ArgumentsHost): void {
          receivedHost = host;
        }
      }

      class TestGateway {
        @UseFilters(ContextFilter)
        handleMessage() {
          throw new Error('Test');
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(receivedHost).not.toBeNull();
      expect(receivedHost!.getType()).toBe('ws');
      expect(receivedHost!.switchToWs().getClient()).toBe(mockClient);
      expect(receivedHost!.switchToWs().getData()).toBe(mockData);
    });

    it('should handle WsException', async () => {
      class TestGateway {
        handleMessage() {
          throw new WsException('Custom error', 'CUSTOM_CODE');
        }
      }

      const gateway = new TestGateway();
      const result = await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(WsException);
      expect((result.error as WsException).error).toBe('CUSTOM_CODE');
    });

    it('should execute full middleware pipeline', async () => {
      const executionOrder: string[] = [];

      class TestGuard implements CanActivate {
        canActivate(): boolean {
          executionOrder.push('guard');
          return true;
        }
      }

      class TestPipe implements PipeTransform {
        transform(value: string): string {
          executionOrder.push('pipe');
          return value;
        }
      }

      class TestFilter implements ExceptionFilter {
        catch(): void {
          executionOrder.push('filter');
        }
      }

      class TestGateway {
        @UseGuards(TestGuard)
        @UseFilters(TestFilter)
        handleMessage(_data: string) {
          executionOrder.push('handler');
          throw new Error('Test error');
        }
      }

      const gateway = new TestGateway();
      applyParamDecorator(TestGateway.prototype, 'handleMessage', 0, ParamType.MESSAGE_BODY);
      applyPipeToParam(TestGateway.prototype, 'handleMessage', 0, TestPipe);

      await executor.execute(gateway, 'handleMessage', mockClient, 'test');

      expect(executionOrder).toEqual(['guard', 'pipe', 'handler', 'filter']);
    });

    it('should execute filter when guard fails', async () => {
      let filterCalled = false;

      class FailingGuard implements CanActivate {
        canActivate(): boolean {
          return false;
        }
      }

      class TestFilter implements ExceptionFilter {
        catch(): void {
          filterCalled = true;
        }
      }

      class TestGateway {
        @UseGuards(FailingGuard)
        @UseFilters(TestFilter)
        handleMessage() {
          throw new Error('Should not reach here');
        }
      }

      const gateway = new TestGateway();
      await executor.execute(gateway, 'handleMessage', mockClient, mockData);

      expect(filterCalled).toBe(true); // Filters now execute for guard denials
    });
  });
});
