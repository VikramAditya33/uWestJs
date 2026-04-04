import { MessageRouter } from './message-router';
import { MessageHandler } from './metadata-scanner';

describe('MessageRouter', () => {
  let router: MessageRouter;
  const mockClient = { id: 'client-123' };
  const mockData = { message: 'hello' };

  const createHandler = (
    message: string,
    callback: (client?: unknown, data?: unknown) => unknown,
    methodName = `handle${message}`
  ): MessageHandler => ({
    message,
    methodName,
    callback,
  });

  beforeEach(() => {
    router = new MessageRouter();
  });

  afterEach(() => {
    router.clear();
  });

  describe('registerHandlers', () => {
    it('should register message handlers', () => {
      const handlers = [createHandler('test', () => 'result')];

      router.registerHandlers(handlers);

      expect(router.hasHandler('test')).toBe(true);
      expect(router.getHandlerCount()).toBe(1);
    });

    it('should register multiple handlers', () => {
      const handlers = [
        createHandler('message1', () => 'result1', 'handle1'),
        createHandler('message2', () => 'result2', 'handle2'),
        createHandler('message3', () => 'result3', 'handle3'),
      ];

      router.registerHandlers(handlers);

      expect(router.getHandlerCount()).toBe(3);
      expect(router.getPatterns()).toEqual(['message1', 'message2', 'message3']);
    });

    it('should overwrite duplicate handlers', () => {
      router.registerHandlers([createHandler('test', () => 'first', 'handler1')]);
      router.registerHandlers([createHandler('test', () => 'second', 'handler2')]);

      expect(router.getHandlerCount()).toBe(1);
    });

    it('should handle empty handler array', () => {
      router.registerHandlers([]);

      expect(router.getHandlerCount()).toBe(0);
    });
  });

  describe('route', () => {
    it('should route message to correct handler', async () => {
      router.registerHandlers([createHandler('test', () => 'test result')]);

      const result = await router.route({ event: 'test' }, {});

      expect(result).toEqual({
        handled: true,
        response: 'test result',
        error: undefined,
      });
    });

    it('should pass client and data to handler', async () => {
      let receivedClient: unknown;
      let receivedData: unknown;

      router.registerHandlers([
        createHandler('test', (client, data) => {
          receivedClient = client;
          receivedData = data;
          return 'ok';
        }),
      ]);

      await router.route({ event: 'test', data: mockData }, mockClient);

      expect(receivedClient).toBe(mockClient);
      expect(receivedData).toBe(mockData);
    });

    it('should handle async handlers', async () => {
      router.registerHandlers([
        createHandler('async', async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'async result';
        }),
      ]);

      const result = await router.route({ event: 'async' }, {});

      expect(result).toEqual({
        handled: true,
        response: 'async result',
        error: undefined,
      });
    });

    it('should handle Promise-returning handlers', async () => {
      router.registerHandlers([createHandler('promise', () => Promise.resolve('promise result'))]);

      const result = await router.route({ event: 'promise' }, {});

      expect(result).toEqual({
        handled: true,
        response: 'promise result',
        error: undefined,
      });
    });

    it('should return handled:false when no handler found', async () => {
      const result = await router.route({ event: 'unknown' }, {});

      expect(result).toEqual({
        handled: false,
        response: undefined,
        error: undefined,
      });
    });

    it('should catch and return handler errors', async () => {
      router.registerHandlers([
        createHandler('error', () => {
          throw new Error('Handler error');
        }),
      ]);

      const result = await router.route({ event: 'error' }, {});

      expect(result.handled).toBe(true);
      expect(result.response).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Handler error');
    });

    it('should catch async handler errors', async () => {
      router.registerHandlers([
        createHandler('async-error', async () => {
          throw new Error('Async error');
        }),
      ]);

      const result = await router.route({ event: 'async-error' }, {});

      expect(result.handled).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Async error');
    });

    it('should handle non-Error throws', async () => {
      router.registerHandlers([
        createHandler('string-error', () => {
          throw 'String error';
        }),
      ]);

      const result = await router.route({ event: 'string-error' }, {});

      expect(result.handled).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('String error');
    });

    it('should handle handlers returning undefined', async () => {
      router.registerHandlers([createHandler('void', () => undefined)]);

      const result = await router.route({ event: 'void' }, {});

      expect(result).toEqual({
        handled: true,
        response: undefined,
        error: undefined,
      });
    });

    it('should handle handlers returning null', async () => {
      router.registerHandlers([createHandler('null', () => null)]);

      const result = await router.route({ event: 'null' }, {});

      expect(result.handled).toBe(true);
      expect(result.response).toBeNull();
    });

    it('should handle handlers returning objects', async () => {
      const responseObj = { status: 'ok', data: [1, 2, 3] };
      router.registerHandlers([createHandler('object', () => responseObj)]);

      const result = await router.route({ event: 'object' }, {});

      expect(result.handled).toBe(true);
      expect(result.response).toBe(responseObj);
    });
  });

  describe('hasHandler', () => {
    it('should return true for registered handlers', () => {
      router.registerHandlers([createHandler('test', () => 'result')]);

      expect(router.hasHandler('test')).toBe(true);
    });

    it('should return false for unregistered handlers', () => {
      expect(router.hasHandler('unknown')).toBe(false);
    });
  });

  describe('getPatterns', () => {
    it('should return all registered patterns', () => {
      const handlers = [
        createHandler('pattern1', () => 'result1', 'handle1'),
        createHandler('pattern2', () => 'result2', 'handle2'),
      ];

      router.registerHandlers(handlers);

      expect(router.getPatterns()).toEqual(['pattern1', 'pattern2']);
    });

    it('should return empty array when no handlers', () => {
      expect(router.getPatterns()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should clear all handlers', () => {
      const handlers = [
        createHandler('test1', () => 'result1', 'handle1'),
        createHandler('test2', () => 'result2', 'handle2'),
      ];

      router.registerHandlers(handlers);
      router.clear();

      expect(router.getHandlerCount()).toBe(0);
      expect(router.getPatterns()).toEqual([]);
    });
  });

  describe('getHandlerCount', () => {
    it('should return correct count', () => {
      expect(router.getHandlerCount()).toBe(0);

      router.registerHandlers([createHandler('test1', () => 'result1', 'handle1')]);
      expect(router.getHandlerCount()).toBe(1);

      router.registerHandlers([createHandler('test2', () => 'result2', 'handle2')]);
      expect(router.getHandlerCount()).toBe(2);
    });
  });
});
