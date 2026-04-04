import { LifecycleHooksManager } from './lifecycle-hooks';

describe('LifecycleHooksManager', () => {
  let manager: LifecycleHooksManager;

  beforeEach(() => {
    manager = new LifecycleHooksManager();
  });

  describe('hook detection', () => {
    it.each([
      ['hasInitHook', 'afterInit'],
      ['hasConnectionHook', 'handleConnection'],
      ['hasDisconnectHook', 'handleDisconnect'],
    ] as const)('%s should detect %s method', (method, hookMethod) => {
      const gateway = { [hookMethod]: jest.fn() };
      expect(manager[method](gateway)).toBe(true);
    });

    it.each([
      ['hasInitHook', 'afterInit'],
      ['hasConnectionHook', 'handleConnection'],
      ['hasDisconnectHook', 'handleDisconnect'],
    ] as const)('%s should return false when %s is missing or invalid', (method, hookMethod) => {
      expect(manager[method](null)).toBe(false);
      expect(manager[method]({})).toBe(false);
      expect(manager[method]({ [hookMethod]: 'not a function' })).toBe(false);
    });
  });

  describe('callInitHook', () => {
    it('should call afterInit with server parameter', async () => {
      const mockServer = { mock: 'server' };
      const afterInitSpy = jest.fn();
      const gateway = { afterInit: afterInitSpy };

      await manager.callInitHook(gateway, mockServer);

      expect(afterInitSpy).toHaveBeenCalledWith(mockServer);
      expect(afterInitSpy).toHaveBeenCalledTimes(1);
    });

    it('should not call anything when gateway lacks afterInit', async () => {
      await expect(manager.callInitHook({}, {})).resolves.toBeUndefined();
    });

    it('should handle async afterInit', async () => {
      let resolved = false;
      const gateway = {
        async afterInit() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          resolved = true;
        },
      };

      await manager.callInitHook(gateway, {});
      expect(resolved).toBe(true);
    });

    it.each([
      ['sync', () => new Error('Init failed')],
      ['async', async () => new Error('Async init failed')],
    ])('should propagate %s errors from afterInit', async (_, errorFn) => {
      const gateway = {
        async afterInit() {
          throw await errorFn();
        },
      };

      await expect(manager.callInitHook(gateway, {})).rejects.toThrow(/init failed/i);
    });
  });

  describe('callConnectionHook', () => {
    const mockClient = { id: 'client-1' };

    it('should call handleConnection with client and additional args', async () => {
      const handleConnectionSpy = jest.fn();
      const gateway = { handleConnection: handleConnectionSpy };
      const extraArgs = ['arg1', { data: 'arg2' }];

      await manager.callConnectionHook(gateway, mockClient, ...extraArgs);

      expect(handleConnectionSpy).toHaveBeenCalledWith(mockClient, ...extraArgs);
      expect(handleConnectionSpy).toHaveBeenCalledTimes(1);
    });

    it('should not call anything when gateway lacks handleConnection', async () => {
      await expect(manager.callConnectionHook({}, mockClient)).resolves.toBeUndefined();
    });

    it('should handle async handleConnection', async () => {
      let resolved = false;
      const gateway = {
        async handleConnection() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          resolved = true;
        },
      };

      await manager.callConnectionHook(gateway, mockClient);
      expect(resolved).toBe(true);
    });

    it.each([
      ['sync', () => new Error('Connection failed')],
      ['async', async () => new Error('Async connection failed')],
    ])('should catch %s errors without rethrowing', async (_, errorFn) => {
      const gateway = {
        async handleConnection() {
          throw await errorFn();
        },
      };

      await expect(manager.callConnectionHook(gateway, mockClient)).resolves.toBeUndefined();
    });
  });

  describe('callDisconnectHook', () => {
    const mockClient = { id: 'client-1' };

    it('should call handleDisconnect with client', async () => {
      const handleDisconnectSpy = jest.fn();
      const gateway = { handleDisconnect: handleDisconnectSpy };

      await manager.callDisconnectHook(gateway, mockClient);

      expect(handleDisconnectSpy).toHaveBeenCalledWith(mockClient);
      expect(handleDisconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('should not call anything when gateway lacks handleDisconnect', async () => {
      await expect(manager.callDisconnectHook({}, mockClient)).resolves.toBeUndefined();
    });

    it('should handle async handleDisconnect', async () => {
      let resolved = false;
      const gateway = {
        async handleDisconnect() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          resolved = true;
        },
      };

      await manager.callDisconnectHook(gateway, mockClient);
      expect(resolved).toBe(true);
    });

    it.each([
      ['sync', () => new Error('Disconnect failed')],
      ['async', async () => new Error('Async disconnect failed')],
    ])('should catch %s errors without rethrowing', async (_, errorFn) => {
      const gateway = {
        async handleDisconnect() {
          throw await errorFn();
        },
      };

      await expect(manager.callDisconnectHook(gateway, mockClient)).resolves.toBeUndefined();
    });
  });

  describe('multiple hooks', () => {
    it('should detect gateway implementing all lifecycle hooks', () => {
      const gateway = {
        afterInit: jest.fn(),
        handleConnection: jest.fn(),
        handleDisconnect: jest.fn(),
      };

      expect(manager.hasInitHook(gateway)).toBe(true);
      expect(manager.hasConnectionHook(gateway)).toBe(true);
      expect(manager.hasDisconnectHook(gateway)).toBe(true);
    });

    it('should execute all lifecycle hooks when called sequentially', async () => {
      const executionOrder: string[] = [];
      const gateway = {
        afterInit: () => executionOrder.push('init'),
        handleConnection: () => executionOrder.push('connection'),
        handleDisconnect: () => executionOrder.push('disconnect'),
      };

      await manager.callInitHook(gateway, {});
      await manager.callConnectionHook(gateway, { id: 'client-1' });
      await manager.callDisconnectHook(gateway, { id: 'client-1' });

      expect(executionOrder).toEqual(['init', 'connection', 'disconnect']);
    });
  });
});
