import { UwsAdapter } from './uws.adapter';
import { PARAM_ARGS_METADATA, ParamType } from '../decorators';
import 'reflect-metadata';
import { UwsSocketImpl } from '../core/socket';

const MESSAGE_MAPPING_METADATA = 'websockets:message_mapping';
const MESSAGE_METADATA = 'message';

/**
 * Helper to add @SubscribeMessage metadata to a method
 */
function addMessageMetadata(target: object, event: string): void {
  Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, target);
  Reflect.defineMetadata(MESSAGE_METADATA, event, target);
}

/**
 * Helper to add parameter decorator metadata to a method
 */
function addParamMetadata(
  target: object,
  methodName: string,
  params: Array<{ index: number; type: ParamType }>
): void {
  Reflect.defineMetadata(PARAM_ARGS_METADATA, params, target, methodName);
}

class TestGateway {
  receivedMessages: Array<{ event: string; data: unknown; client: unknown }> = [];

  handlePing(client: unknown, data: unknown) {
    this.receivedMessages.push({ event: 'ping', data, client });
    return { event: 'pong', data: { timestamp: Date.now() } };
  }

  handleEcho(data: unknown) {
    this.receivedMessages.push({ event: 'echo', data, client: null });
    return data;
  }

  handleError(_data: unknown) {
    throw new Error('Handler error');
  }

  handleNoResponse(data: unknown) {
    this.receivedMessages.push({ event: 'no-response', data, client: null });
  }
}

// Configure metadata for TestGateway methods
addMessageMetadata(TestGateway.prototype.handlePing, 'ping');
addMessageMetadata(TestGateway.prototype.handleEcho, 'echo');
addMessageMetadata(TestGateway.prototype.handleError, 'error');
addMessageMetadata(TestGateway.prototype.handleNoResponse, 'no-response');

addParamMetadata(TestGateway.prototype, 'handlePing', [
  { index: 0, type: ParamType.CONNECTED_SOCKET },
  { index: 1, type: ParamType.MESSAGE_BODY },
]);
addParamMetadata(TestGateway.prototype, 'handleEcho', [{ index: 0, type: ParamType.MESSAGE_BODY }]);
addParamMetadata(TestGateway.prototype, 'handleError', [
  { index: 0, type: ParamType.MESSAGE_BODY },
]);
addParamMetadata(TestGateway.prototype, 'handleNoResponse', [
  { index: 0, type: ParamType.MESSAGE_BODY },
]);

/**
 * Helper to create a mock WebSocket client
 */
function createMockClient(id = 'test-client') {
  return {
    id,
    send: jest.fn(),
    close: jest.fn(),
  };
}

/**
 * Helper to create a mock wrapped socket
 */
function createMockWrappedSocket(id = 'test-client') {
  return {
    id,
    emit: jest.fn(),
    broadcast: { emit: jest.fn() },
    to: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    leaveAll: jest.fn(),
    rooms: new Set<string>(),
  };
}

describe('UwsAdapter Integration with Router', () => {
  let adapter: UwsAdapter;
  let gateway: TestGateway;

  beforeEach(() => {
    adapter = new UwsAdapter(null, { port: 8099 });
    gateway = new TestGateway();
  });

  afterEach(() => {
    adapter?.dispose();
  });

  describe('registerGateway', () => {
    it('should scan and register handlers from gateway', () => {
      adapter.registerGateway(gateway);

      // Verify handlers were actually registered
      const messageRouter = (adapter as any).messageRouter;
      expect(messageRouter.getHandlerCount()).toBe(4);
      expect(messageRouter.hasHandler('ping')).toBe(true);
      expect(messageRouter.hasHandler('echo')).toBe(true);
      expect(messageRouter.hasHandler('error')).toBe(true);
      expect(messageRouter.hasHandler('no-response')).toBe(true);
    });

    it('should handle invalid gateway instance', () => {
      // registerGateway is the preferred API for gateway registration
      // Only test null/undefined as other types are TypeScript errors
      expect(() => adapter.registerGateway(null as any)).not.toThrow();
      expect(() => adapter.registerGateway(undefined as any)).not.toThrow();
    });

    it('should handle gateway with no handlers', () => {
      class EmptyGateway {}
      const emptyGateway = new EmptyGateway();

      expect(() => {
        adapter.registerGateway(emptyGateway);
      }).not.toThrow();
    });
  });

  describe('decorator-based message routing', () => {
    beforeEach(() => {
      adapter.registerGateway(gateway);
    });

    it('should route messages to correct handlers with parameters', async () => {
      const mockClient = createMockClient();
      const mockWrappedSocket = createMockWrappedSocket();
      (adapter as any).sockets.set('test-client', mockWrappedSocket);

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'echo', data: { message: 'hello' } })
      );
      expect(gateway.receivedMessages[0]).toEqual({
        event: 'echo',
        data: { message: 'hello' },
        client: null,
      });
      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'echo', data: { message: 'hello' } })
      );

      gateway.receivedMessages = [];
      mockClient.send.mockClear();

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'ping', data: { timestamp: 123456 } })
      );
      expect(gateway.receivedMessages[0].event).toBe('ping');
      // The handler receives the wrapped socket, not the raw client
      expect(gateway.receivedMessages[0].client).toBe(mockWrappedSocket);
      expect(mockClient.send).toHaveBeenCalled();
    });

    it('should handle errors and no-response handlers', async () => {
      const mockClient = createMockClient();
      const mockWrappedSocket = createMockWrappedSocket();
      (adapter as any).sockets.set('test-client', mockWrappedSocket);

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'error', data: {} })
      );
      expect(mockClient.send).not.toHaveBeenCalled();

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'no-response', data: { test: 'data' } })
      );
      expect(gateway.receivedMessages).toHaveLength(1);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should handle invalid messages gracefully', async () => {
      const mockClient = createMockClient();

      await (adapter as any).handleDecoratorBasedMessage(mockClient, 'not valid json');
      expect(mockClient.send).not.toHaveBeenCalled();

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ data: { message: 'hello' } })
      );
      expect(gateway.receivedMessages).toHaveLength(0);

      await (adapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'unknown-event', data: {} })
      );
      expect(gateway.receivedMessages).toHaveLength(0);
    });

    it('should handle missing gateway gracefully', async () => {
      const freshAdapter = new UwsAdapter(null, { port: 8100 });
      const mockClient = createMockClient();

      await (freshAdapter as any).handleDecoratorBasedMessage(
        mockClient,
        JSON.stringify({ event: 'echo', data: { message: 'hello' } })
      );
      expect(mockClient.send).not.toHaveBeenCalled();
      freshAdapter.dispose();
    });
  });

  describe('sendResponse', () => {
    it('should send formatted response to client', () => {
      const mockClient = createMockClient();

      (adapter as any).sendResponse(mockClient, 'test-event', { result: 'success' });

      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'test-event',
          data: { result: 'success' },
        })
      );
    });

    it('should handle send errors gracefully', () => {
      const mockClient = createMockClient();
      mockClient.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      expect(() => {
        (adapter as any).sendResponse(mockClient, 'test-event', { data: 'test' });
      }).not.toThrow();
    });
  });
});

describe('Room Operations Integration', () => {
  let adapter: UwsAdapter;

  beforeEach(() => {
    adapter = new UwsAdapter(null, { port: 8099 });
  });

  afterEach(() => {
    adapter?.dispose();
  });

  describe('getSocket', () => {
    it('should return undefined for non-existent client', () => {
      const socket = adapter.getSocket('non-existent-id');
      expect(socket).toBeUndefined();
    });

    it('should return socket after client connects', () => {
      // Simulate client connection by directly adding to sockets map
      const mockNativeSocket = {
        send: jest.fn(),
        close: jest.fn(),
        getBufferedAmount: jest.fn().mockReturnValue(0),
      } as any;

      const roomManager = (adapter as any).roomManager;
      const broadcastFn = (adapter as any).broadcastToRooms.bind(adapter);
      const socket = new UwsSocketImpl(
        'test-client-id',
        mockNativeSocket,
        roomManager,
        broadcastFn
      );

      (adapter as any).sockets.set('test-client-id', socket);

      const retrievedSocket = adapter.getSocket('test-client-id');
      expect(retrievedSocket).toBe(socket);
      expect(retrievedSocket?.id).toBe('test-client-id');
    });
  });

  describe('broadcastToRooms', () => {
    let mockClients: Map<string, any>;

    beforeEach(() => {
      mockClients = new Map([
        ['client-1', { id: 'client-1', send: jest.fn().mockReturnValue(0), close: jest.fn() }],
        ['client-2', { id: 'client-2', send: jest.fn().mockReturnValue(0), close: jest.fn() }],
        ['client-3', { id: 'client-3', send: jest.fn().mockReturnValue(0), close: jest.fn() }],
      ]);

      mockClients.forEach((client, id) => (adapter as any).clients.set(id, client));

      const roomManager = (adapter as any).roomManager;
      roomManager.join('client-1', 'room1');
      roomManager.join('client-2', ['room1', 'room2']);
      roomManager.join('client-3', 'room2');
    });

    it('should broadcast to specific rooms', () => {
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, ['room1']);

      expect(mockClients.get('client-1')!.send).toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).toHaveBeenCalled();
      expect(mockClients.get('client-3')!.send).not.toHaveBeenCalled();

      jest.clearAllMocks();
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, ['room1', 'room2']);
      mockClients.forEach((client) => expect(client.send).toHaveBeenCalled());
    });

    it('should broadcast to all clients when no rooms specified', () => {
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' });
      mockClients.forEach((client) => expect(client.send).toHaveBeenCalled());
    });

    it('should exclude specific client from broadcast', () => {
      (adapter as any).broadcastToRooms(
        'test-event',
        { message: 'hello' },
        ['room1'],
        ['client-1']
      );
      expect(mockClients.get('client-1')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).toHaveBeenCalled();

      jest.clearAllMocks();
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, undefined, [
        'client-2',
      ]);
      expect(mockClients.get('client-1')!.send).toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-3')!.send).toHaveBeenCalled();
    });

    it('should exclude multiple clients from broadcast', () => {
      // Broadcasting to room1 which has client-1 and client-2
      // Excluding both means nobody in room1 receives the message
      (adapter as any).broadcastToRooms(
        'test-event',
        { message: 'hello' },
        ['room1'],
        ['client-1', 'client-2']
      );
      expect(mockClients.get('client-1')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-3')!.send).not.toHaveBeenCalled(); // Not in room1

      jest.clearAllMocks();
      // Broadcasting to all rooms, excluding client-1 and client-2
      // Only client-3 should receive
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, undefined, [
        'client-1',
        'client-2',
      ]);
      expect(mockClients.get('client-1')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-3')!.send).toHaveBeenCalled();
    });

    it('should handle empty rooms gracefully', () => {
      expect(() => {
        (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, ['empty-room']);
      }).not.toThrow();
      mockClients.forEach((client) => expect(client.send).not.toHaveBeenCalled());
    });

    it('should handle per-client send failures gracefully', () => {
      mockClients.get('client-1')!.send.mockImplementation(() => {
        throw new Error('Send failed');
      });
      expect(() => {
        (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, ['room1']);
      }).not.toThrow();
      expect(mockClients.get('client-2')!.send).toHaveBeenCalled();
    });

    it('should deduplicate clients when broadcasting to duplicate rooms', () => {
      // client-1 is in room1
      // Broadcasting to ['room1', 'room1'] should only send once to client-1
      (adapter as any).broadcastToRooms('test-event', { message: 'hello' }, ['room1', 'room1']);

      // Verify client-1 received exactly one message (not two)
      expect(mockClients.get('client-1')!.send).toHaveBeenCalledTimes(1);
      expect(mockClients.get('client-2')!.send).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate excluded clients', () => {
      // Broadcasting to room1 with duplicate exclusions
      // client-1 should be excluded only once (not cause issues)
      (adapter as any).broadcastToRooms(
        'test-event',
        { message: 'hello' },
        ['room1'],
        ['client-1', 'client-1']
      );

      expect(mockClients.get('client-1')!.send).not.toHaveBeenCalled();
      expect(mockClients.get('client-2')!.send).toHaveBeenCalled();
    });
  });

  describe('room cleanup on disconnect', () => {
    it('should remove client from all rooms and clean up empty rooms', () => {
      const roomManager = (adapter as any).roomManager;

      roomManager.join('client-1', ['room1', 'room2', 'room3']);
      expect(roomManager.isClientInRoom('client-1', 'room1')).toBe(true);
      expect(roomManager.getRoomCount()).toBe(3);

      roomManager.leaveAll('client-1');
      expect(roomManager.isClientInRoom('client-1', 'room1')).toBe(false);
      expect(roomManager.isClientInRoom('client-1', 'room2')).toBe(false);
      expect(roomManager.isClientInRoom('client-1', 'room3')).toBe(false);
      expect(roomManager.getRoomCount()).toBe(0);
    });
  });
});
