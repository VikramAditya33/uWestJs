import { UwsSocketImpl } from './socket';

describe('UwsSocketImpl', () => {
  let socket: UwsSocketImpl;
  let mockNativeSocket: any;
  let mockRoomManager: any;
  let mockBroadcastFn: jest.Mock;

  beforeEach(() => {
    // Create a mock native socket
    mockNativeSocket = {
      send: jest.fn(),
      close: jest.fn(),
      getBufferedAmount: jest.fn().mockReturnValue(0),
    };

    // Create a mock room manager
    mockRoomManager = {
      join: jest.fn(),
      leave: jest.fn(),
      leaveAll: jest.fn(),
      getClientsInRoom: jest.fn().mockReturnValue(new Set()),
      getRoomsForClient: jest.fn().mockReturnValue(new Set()),
    };

    // Create a mock broadcast function
    mockBroadcastFn = jest.fn();

    socket = new UwsSocketImpl('test-id-123', mockNativeSocket, mockRoomManager, mockBroadcastFn);
  });

  describe('initialization', () => {
    it('should create a socket with an id', () => {
      expect(socket).toBeDefined();
      expect(socket.id).toBe('test-id-123');
    });

    it('should have empty data by default', () => {
      expect(socket.data).toEqual({});
    });

    it('should allow setting custom data', () => {
      socket.data = { userId: 'user-123', username: 'testuser' };
      expect(socket.data).toEqual({ userId: 'user-123', username: 'testuser' });
    });
  });

  describe('emit', () => {
    it('should send messages with various data types', () => {
      socket.emit('test-event', { message: 'hello' });
      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'test-event', data: { message: 'hello' } })
      );

      mockNativeSocket.send.mockClear();
      socket.emit('message', 'hello world');
      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'message', data: 'hello world' })
      );

      mockNativeSocket.send.mockClear();
      socket.emit('count', 42);
      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'count', data: 42 })
      );

      mockNativeSocket.send.mockClear();
      socket.emit('empty', null);
      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'empty', data: null })
      );
    });

    it('should handle undefined or omitted data', () => {
      socket.emit('ping', undefined);
      expect(mockNativeSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: 'ping' }));

      mockNativeSocket.send.mockClear();
      socket.emit('heartbeat');
      expect(mockNativeSocket.send).toHaveBeenCalledWith(JSON.stringify({ event: 'heartbeat' }));
    });

    it('should throw error if send fails or data is non-serializable', () => {
      mockNativeSocket.send.mockImplementation(() => {
        throw new Error('Send failed');
      });
      expect(() => socket.emit('test', 'data')).toThrow('Failed to emit event "test"');

      mockNativeSocket.send.mockReset();
      const circular: any = {};
      circular.self = circular;
      expect(() => socket.emit('test', circular)).toThrow('Failed to emit event "test"');
    });
  });

  describe('disconnect', () => {
    it('should close the native socket', () => {
      socket.disconnect();

      expect(mockNativeSocket.close).toHaveBeenCalledTimes(1);
    });

    it('should throw error if close fails', () => {
      mockNativeSocket.close.mockImplementation(() => {
        throw new Error('Close failed');
      });

      expect(() => {
        socket.disconnect();
      }).toThrow('Failed to disconnect socket test-id-123');
    });
  });

  describe('getBufferedAmount', () => {
    it('should return buffered amount from native socket', () => {
      mockNativeSocket.getBufferedAmount.mockReturnValue(1024);
      expect(socket.getBufferedAmount()).toBe(1024);

      mockNativeSocket.getBufferedAmount.mockReturnValue(0);
      expect(socket.getBufferedAmount()).toBe(0);
    });

    it('should return 0 if native socket throws error', () => {
      mockNativeSocket.getBufferedAmount.mockImplementation(() => {
        throw new Error('Socket closed');
      });
      expect(socket.getBufferedAmount()).toBe(0);
    });
  });

  describe('room operations', () => {
    describe('join', () => {
      it('should join a single room', () => {
        socket.join('room1');
        expect(mockRoomManager.join).toHaveBeenCalledWith('test-id-123', 'room1');
      });

      it('should join multiple rooms', () => {
        socket.join(['room1', 'room2']);
        expect(mockRoomManager.join).toHaveBeenCalledWith('test-id-123', ['room1', 'room2']);
      });
    });

    describe('leave', () => {
      it('should leave a single room', () => {
        socket.leave('room1');
        expect(mockRoomManager.leave).toHaveBeenCalledWith('test-id-123', 'room1');
      });

      it('should leave multiple rooms', () => {
        socket.leave(['room1', 'room2']);
        expect(mockRoomManager.leave).toHaveBeenCalledWith('test-id-123', ['room1', 'room2']);
      });
    });

    describe('to', () => {
      it('should emit to single or multiple rooms with chaining', () => {
        socket.to('room1').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1'],
          ['test-id-123'] // Sender is excluded (Socket.IO-compatible)
        );

        mockBroadcastFn.mockClear();
        socket.to(['room1', 'room2']).emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1', 'room2'],
          ['test-id-123'] // Sender is excluded (Socket.IO-compatible)
        );

        mockBroadcastFn.mockClear();
        socket.to('room1').to('room2').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1', 'room2'],
          ['test-id-123'] // Sender is excluded (Socket.IO-compatible)
        );
      });

      it('should support except() for excluding clients', () => {
        socket.to('room1').except('client-2').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1'],
          ['test-id-123', 'client-2'] // Sender + client-2 both excluded
        );
      });
    });

    describe('broadcast', () => {
      it('should broadcast to all clients except sender', () => {
        socket.broadcast.emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith('message', { text: 'hello' }, undefined, [
          'test-id-123',
        ]);
      });

      it('should broadcast to rooms with chaining', () => {
        socket.broadcast.to('room1').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1'],
          ['test-id-123']
        );

        mockBroadcastFn.mockClear();
        socket.broadcast.to(['room1', 'room2']).emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1', 'room2'],
          ['test-id-123']
        );

        mockBroadcastFn.mockClear();
        socket.broadcast.to('room1').to('room2').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1', 'room2'],
          ['test-id-123']
        );
      });

      it('should support except() on broadcast', () => {
        socket.broadcast.except('client-2').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          undefined,
          ['test-id-123', 'client-2'] // except() accumulates with sender exclusion
        );

        mockBroadcastFn.mockClear();
        socket.broadcast.to('room1').except('client-2').emit('message', { text: 'hello' });
        expect(mockBroadcastFn).toHaveBeenCalledWith(
          'message',
          { text: 'hello' },
          ['room1'],
          ['test-id-123', 'client-2'] // except() accumulates with sender exclusion
        );
      });
    });
  });

  describe('getNativeSocket', () => {
    it('should return the native socket', () => {
      const native = socket.getNativeSocket();
      expect(native).toBe(mockNativeSocket);
    });
  });

  describe('data property', () => {
    it('should allow storing and updating user data', () => {
      interface UserData {
        userId: string;
        username: string;
        role: string;
      }

      const typedSocket = socket as UwsSocketImpl<UserData>;
      typedSocket.data = {
        userId: 'user-123',
        username: 'vikram_aditya',
        role: 'admin',
      };

      expect(typedSocket.data.userId).toBe('user-123');
      expect(typedSocket.data.username).toBe('vikram_aditya');
      expect(typedSocket.data.role).toBe('admin');

      typedSocket.data = { userId: 'user-456', username: 'paan_singh_tomar', role: 'user' };
      expect(typedSocket.data.userId).toBe('user-456');
      expect(typedSocket.data.username).toBe('paan_singh_tomar');
      expect(typedSocket.data.role).toBe('user');
    });
  });
});
