import { UwsAdapter } from './uws.adapter';

describe('UwsAdapter', () => {
  let adapter: UwsAdapter;

  // Helper to create circular reference for testing
  const createCircularObject = () => {
    const circular: any = {};
    circular.self = circular;
    return circular;
  };

  beforeEach(() => {
    adapter = new UwsAdapter(null, {
      port: 8099,
      maxPayloadLength: 16 * 1024,
      idleTimeout: 60,
    });
  });

  afterEach(() => {
    adapter?.dispose();
  });

  describe('initialization', () => {
    it('should create an adapter instance', () => {
      expect(adapter).toBeDefined();
      expect(adapter).toBeInstanceOf(UwsAdapter);
    });

    it('should apply default options when none provided', () => {
      const defaultAdapter = new UwsAdapter(null);
      expect(defaultAdapter).toBeDefined();
      expect(defaultAdapter.getClientCount()).toBe(0);
      defaultAdapter.dispose();
    });
  });

  describe('client management', () => {
    it('should start with zero clients', () => {
      expect(adapter.getClientCount()).toBe(0);
    });

    it('should return empty array for client IDs when no clients', () => {
      expect(adapter.getClientIds()).toEqual([]);
    });

    it('should return false when checking for non-existent client', () => {
      expect(adapter.hasClient('non-existent-id')).toBe(false);
    });
  });

  describe('messaging', () => {
    it('should return false when sending to non-existent client', () => {
      const result = adapter.sendToClient('non-existent-id', { test: 'data' });
      expect(result).toBe(false);
    });

    it('should handle broadcast with no clients gracefully', () => {
      expect(() => adapter.broadcast({ test: 'data' })).not.toThrow();
    });

    it('should handle non-serializable data gracefully', () => {
      const mockClient = {
        send: jest.fn().mockReturnValue(0),
        id: 'mock-client-id',
      } as any;

      (adapter as any).clients.set('mock-client-id', mockClient);

      try {
        // Test sendToClient with circular object
        const sendResult = adapter.sendToClient('mock-client-id', createCircularObject());
        expect(sendResult).toBe(false);
        expect(mockClient.send).not.toHaveBeenCalled();

        mockClient.send.mockClear();

        // Test broadcast with circular object
        expect(() => adapter.broadcast(createCircularObject())).not.toThrow();
        expect(mockClient.send).not.toHaveBeenCalled();
      } finally {
        (adapter as any).clients.delete('mock-client-id');
      }
    });
  });

  describe('server lifecycle', () => {
    it('should create and close server', async () => {
      const server = await adapter.create(0); // Let OS decide the port
      expect(server).toBeDefined();
      expect(() => adapter.close(null)).not.toThrow();
    });

    it('should handle multiple dispose calls', () => {
      adapter.dispose();
      expect(() => adapter.dispose()).not.toThrow();
    });
  });

  describe('handler registration', () => {
    it('should register WebSocket handler', () => {
      const handler = {
        handleConnection: jest.fn(),
        handleMessage: jest.fn(),
        handleDisconnect: jest.fn(),
      };

      expect(() => adapter.setWebSocketHandler(handler)).not.toThrow();
    });
  });
});
