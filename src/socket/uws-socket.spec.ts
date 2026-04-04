import { UwsSocketImpl } from './uws-socket';

describe('UwsSocketImpl', () => {
  let socket: UwsSocketImpl;
  let mockNativeSocket: any;

  beforeEach(() => {
    // Create a mock native socket
    mockNativeSocket = {
      send: jest.fn(),
      close: jest.fn(),
      getBufferedAmount: jest.fn().mockReturnValue(0),
    };

    socket = new UwsSocketImpl('test-id-123', mockNativeSocket);
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
    it('should send a message with event and data', () => {
      socket.emit('test-event', { message: 'hello' });

      expect(mockNativeSocket.send).toHaveBeenCalledTimes(1);
      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'test-event', data: { message: 'hello' } })
      );
    });

    it('should handle string data', () => {
      socket.emit('message', 'hello world');

      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'message', data: 'hello world' })
      );
    });

    it('should handle number data', () => {
      socket.emit('count', 42);

      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'count', data: 42 })
      );
    });

    it('should handle null data', () => {
      socket.emit('empty', null);

      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'empty', data: null })
      );
    });

    it('should handle undefined data', () => {
      socket.emit('ping', undefined);

      expect(mockNativeSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'ping', data: undefined })
      );
    });

    it('should throw error if send fails', () => {
      mockNativeSocket.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      expect(() => {
        socket.emit('test', 'data');
      }).toThrow('Failed to emit event "test"');
    });

    it('should handle non-serializable data', () => {
      const circular: any = {};
      circular.self = circular;

      expect(() => {
        socket.emit('test', circular);
      }).toThrow();
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

      const amount = socket.getBufferedAmount();

      expect(amount).toBe(1024);
      expect(mockNativeSocket.getBufferedAmount).toHaveBeenCalledTimes(1);
    });

    it('should return 0 if native socket throws error', () => {
      mockNativeSocket.getBufferedAmount.mockImplementation(() => {
        throw new Error('Socket closed');
      });

      const amount = socket.getBufferedAmount();

      expect(amount).toBe(0);
    });

    it('should handle zero buffered amount', () => {
      mockNativeSocket.getBufferedAmount.mockReturnValue(0);

      const amount = socket.getBufferedAmount();

      expect(amount).toBe(0);
    });

    it('should handle large buffered amount', () => {
      mockNativeSocket.getBufferedAmount.mockReturnValue(1024 * 1024 * 10); // 10MB

      const amount = socket.getBufferedAmount();

      expect(amount).toBe(1024 * 1024 * 10);
    });
  });

  describe('room methods (not yet implemented)', () => {
    it('should throw error for join', () => {
      expect(() => {
        socket.join('room1');
      }).toThrow('Room management not yet implemented');
    });

    it('should throw error for leave', () => {
      expect(() => {
        socket.leave('room1');
      }).toThrow('Room management not yet implemented');
    });

    it('should throw error for to', () => {
      expect(() => {
        socket.to('room1');
      }).toThrow('Room management not yet implemented');
    });

    it('should throw error for broadcast', () => {
      expect(() => {
        socket.broadcast;
      }).toThrow('Room management not yet implemented');
    });
  });

  describe('getNativeSocket', () => {
    it('should return the native socket', () => {
      const native = socket.getNativeSocket();
      expect(native).toBe(mockNativeSocket);
    });
  });

  describe('data property', () => {
    it('should allow storing user information', () => {
      interface UserData {
        userId: string;
        username: string;
        role: string;
      }

      const typedSocket = socket as UwsSocketImpl<UserData>;
      typedSocket.data = {
        userId: 'user-123',
        username: 'john_doe',
        role: 'admin',
      };

      expect(typedSocket.data.userId).toBe('user-123');
      expect(typedSocket.data.username).toBe('john_doe');
      expect(typedSocket.data.role).toBe('admin');
    });

    it('should allow updating data', () => {
      interface CountData {
        count: number;
      }

      const typedSocket = socket as UwsSocketImpl<CountData>;
      typedSocket.data = { count: 0 };
      expect(typedSocket.data.count).toBe(0);

      typedSocket.data = { count: 1 };
      expect(typedSocket.data.count).toBe(1);
    });

    it('should allow storing complex objects', () => {
      interface ComplexData {
        user: {
          id: string;
          profile: {
            name: string;
            age: number;
          };
        };
        session: {
          token: string;
          expiresAt: Date;
        };
      }

      const typedSocket = socket as UwsSocketImpl<ComplexData>;
      typedSocket.data = {
        user: {
          id: '123',
          profile: {
            name: 'John',
            age: 30,
          },
        },
        session: {
          token: 'abc123',
          expiresAt: new Date(),
        },
      };

      expect(typedSocket.data.user.profile.name).toBe('John');
      expect(typedSocket.data.session.token).toBe('abc123');
    });
  });
});
