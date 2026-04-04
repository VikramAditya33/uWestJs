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

    it('should be accessible via getInstance', () => {
      const instance = UwsAdapter.getInstance();
      expect(instance).toBe(adapter);
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

    it('should handle non-serializable data in sendToClient', () => {
      const result = adapter.sendToClient('test-id', createCircularObject());
      expect(result).toBe(false);
    });

    it('should handle non-serializable data in broadcast', () => {
      expect(() => adapter.broadcast(createCircularObject())).not.toThrow();
    });
  });

  describe('server lifecycle', () => {
    it('should create server', async () => {
      const server = await adapter.create(8099);
      expect(server).toBeDefined();
    });

    it('should close gracefully', () => {
      expect(() => adapter.close(null)).not.toThrow();
    });

    it('should dispose gracefully', () => {
      expect(() => adapter.dispose()).not.toThrow();
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
