import { RoomManager } from './room-manager';

describe('RoomManager', () => {
  let roomManager: RoomManager;

  beforeEach(() => {
    roomManager = new RoomManager();
  });

  describe('join', () => {
    it('should add client to single or multiple rooms', () => {
      roomManager.join('client-1', 'lobby');
      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(true);

      roomManager.join('client-2', ['game-1', 'chat']);
      expect(roomManager.getRoomsForClient('client-2').size).toBe(2);
    });

    it('should support multiple clients in same room', () => {
      roomManager.join('client-1', 'lobby');
      roomManager.join('client-2', 'lobby');
      roomManager.join('client-3', 'lobby');

      expect(roomManager.getClientsInRoom('lobby').size).toBe(3);
    });

    it('should be idempotent and handle empty arrays', () => {
      roomManager.join('client-1', 'lobby');
      roomManager.join('client-1', 'lobby');
      expect(roomManager.getClientsInRoom('lobby').size).toBe(1);

      roomManager.join('client-2', []);
      expect(roomManager.getRoomsForClient('client-2').size).toBe(0);
    });

    it('should reject empty clientId', () => {
      roomManager.join('', 'lobby');
      expect(roomManager.getClientsInRoom('lobby').size).toBe(0);
    });

    it('should filter out empty room names', () => {
      roomManager.join('client-1', ['lobby', '', 'game-1']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(2);
      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(true);
      expect(roomManager.isClientInRoom('client-1', 'game-1')).toBe(true);
    });

    it('should trim and reject whitespace-only room names', () => {
      roomManager.join('client-1', ['  lobby  ', '   ', 'game-1']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(2);
      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(true);
      expect(roomManager.isClientInRoom('client-1', 'game-1')).toBe(true);
      // Lookups are now consistent - trimmed room names match
      expect(roomManager.isClientInRoom('client-1', '  lobby  ')).toBe(true);
    });

    it('should reject when all room names are empty', () => {
      roomManager.join('client-1', ['', '']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(0);
    });
  });

  describe('leave', () => {
    it('should remove client from single or multiple rooms', () => {
      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      roomManager.join('client-2', 'lobby');

      roomManager.leave('client-1', 'lobby');
      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(false);
      expect(roomManager.isClientInRoom('client-1', 'game-1')).toBe(true);

      roomManager.leave('client-1', ['game-1', 'chat']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(0);
    });

    it('should auto-cleanup empty rooms and not affect other clients', () => {
      roomManager.join('client-1', 'game-1');
      roomManager.join('client-2', 'lobby');

      roomManager.leave('client-1', 'game-1');
      expect(roomManager.getAllRooms()).toEqual(['lobby']);
      expect(roomManager.isClientInRoom('client-2', 'lobby')).toBe(true);
    });

    it('should handle non-existent rooms and empty arrays gracefully', () => {
      roomManager.join('client-1', 'lobby');
      const roomsBefore = roomManager.getRoomsForClient('client-1').size;

      expect(() => roomManager.leave('client-1', 'non-existent')).not.toThrow();
      expect(roomManager.getRoomsForClient('client-1').size).toBe(roomsBefore);

      roomManager.leave('client-1', []);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(roomsBefore);
    });

    it('should reject empty clientId', () => {
      roomManager.join('client-1', 'lobby');
      roomManager.leave('', 'lobby');
      expect(roomManager.getClientsInRoom('lobby').size).toBe(1);
    });

    it('should filter out empty room names', () => {
      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      roomManager.leave('client-1', ['lobby', '', 'game-1']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(1);
      expect(roomManager.isClientInRoom('client-1', 'chat')).toBe(true);
    });

    it('should trim and reject whitespace-only room names', () => {
      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      roomManager.leave('client-1', ['  lobby  ', '   ', 'game-1']);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(1);
      expect(roomManager.isClientInRoom('client-1', 'chat')).toBe(true);
    });
  });

  describe('leaveAll', () => {
    it('should remove client from all rooms and cleanup', () => {
      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      roomManager.join('client-2', ['lobby', 'game-1']);

      roomManager.leaveAll('client-1');

      expect(roomManager.getRoomsForClient('client-1').size).toBe(0);
      expect(roomManager.getAllRooms()).not.toContain('chat');
      expect(roomManager.isClientInRoom('client-2', 'lobby')).toBe(true);
    });

    it('should handle non-existent client gracefully', () => {
      expect(() => roomManager.leaveAll('non-existent')).not.toThrow();
    });

    it('should reject empty clientId', () => {
      roomManager.join('client-1', 'lobby');
      roomManager.leaveAll('');
      expect(roomManager.getClientsInRoom('lobby').size).toBe(1);
    });
  });

  describe('queries', () => {
    it('should return clients in room or empty set', () => {
      roomManager.join('client-1', 'lobby');
      roomManager.join('client-2', 'lobby');

      expect(roomManager.getClientsInRoom('lobby').size).toBe(2);
      expect(roomManager.getClientsInRoom('non-existent').size).toBe(0);
    });

    it('should return rooms for client or empty set', () => {
      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);

      expect(roomManager.getRoomsForClient('client-1').size).toBe(3);
      expect(roomManager.getRoomsForClient('non-existent').size).toBe(0);
    });

    it('should return copies that do not affect internal state', () => {
      roomManager.join('client-1', 'lobby');

      const clients = roomManager.getClientsInRoom('lobby');
      clients.add('client-999');
      expect(roomManager.getClientsInRoom('lobby').has('client-999')).toBe(false);

      const rooms = roomManager.getRoomsForClient('client-1');
      rooms.add('fake-room');
      expect(roomManager.getRoomsForClient('client-1').has('fake-room')).toBe(false);
    });
  });

  describe('counters', () => {
    it('should track room count with auto-cleanup', () => {
      expect(roomManager.getRoomCount()).toBe(0);

      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      expect(roomManager.getRoomCount()).toBe(3);

      roomManager.leave('client-1', 'lobby');
      expect(roomManager.getRoomCount()).toBe(2);
    });

    it('should count each client once regardless of room membership', () => {
      expect(roomManager.getClientCount()).toBe(0);

      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      roomManager.join('client-2', 'lobby');
      expect(roomManager.getClientCount()).toBe(2);

      roomManager.leaveAll('client-1');
      expect(roomManager.getClientCount()).toBe(1);
    });

    it('should check client membership in rooms', () => {
      roomManager.join('client-1', 'lobby');

      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(true);
      expect(roomManager.isClientInRoom('client-1', 'game-1')).toBe(false);
      expect(roomManager.isClientInRoom('non-existent', 'lobby')).toBe(false);
    });

    it('should list all active rooms excluding empty ones', () => {
      expect(roomManager.getAllRooms()).toEqual([]);

      roomManager.join('client-1', ['lobby', 'game-1', 'chat']);
      expect(roomManager.getAllRooms()).toHaveLength(3);

      roomManager.leave('client-1', 'lobby');
      expect(roomManager.getAllRooms()).not.toContain('lobby');
    });
  });

  describe('clear', () => {
    it('should reset all state and allow new operations', () => {
      roomManager.join('client-1', ['lobby', 'game-1']);
      roomManager.join('client-2', ['lobby', 'chat']);

      roomManager.clear();

      expect(roomManager.getRoomCount()).toBe(0);
      expect(roomManager.getClientCount()).toBe(0);
      expect(roomManager.getAllRooms()).toEqual([]);

      roomManager.join('client-1', 'lobby');
      expect(roomManager.isClientInRoom('client-1', 'lobby')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should scale to many clients and rooms', () => {
      for (let i = 0; i < 100; i++) {
        const rooms = Array.from({ length: 10 }, (_, j) => `room-${j}`);
        roomManager.join(`client-${i}`, rooms);
      }

      expect(roomManager.getClientCount()).toBe(100);
      expect(roomManager.getRoomCount()).toBe(10);
      expect(roomManager.getClientsInRoom('room-0').size).toBe(100);
    });

    it('should scale to many rooms per client', () => {
      const rooms = Array.from({ length: 100 }, (_, i) => `room-${i}`);
      roomManager.join('client-1', rooms);

      expect(roomManager.getRoomsForClient('client-1').size).toBe(100);
      expect(roomManager.getRoomCount()).toBe(100);
    });

    it('should handle very long room names', () => {
      const longRoomName = 'room-' + 'x'.repeat(1000);
      roomManager.join('client-1', longRoomName);

      expect(roomManager.isClientInRoom('client-1', longRoomName)).toBe(true);
      expect(roomManager.getClientsInRoom(longRoomName).size).toBe(1);
    });

    it('should handle special characters in room names', () => {
      const specialRooms = ['room:123', 'room/test', 'room@special', 'room#tag'];
      roomManager.join('client-1', specialRooms);

      specialRooms.forEach((room) => {
        expect(roomManager.isClientInRoom('client-1', room)).toBe(true);
      });
    });

    it('should maintain consistency through complex operations', () => {
      roomManager.join('client-1', ['lobby', 'game-1']);
      roomManager.join('client-2', 'lobby');
      roomManager.leave('client-1', 'lobby');
      roomManager.join('client-3', ['game-1', 'chat']);
      roomManager.leaveAll('client-2');
      roomManager.join('client-1', 'chat');

      expect(roomManager.getClientsInRoom('game-1').size).toBe(2);
      expect(roomManager.getClientsInRoom('chat').size).toBe(2);
      expect(roomManager.getRoomsForClient('client-1').size).toBe(2);
      expect(roomManager.getRoomsForClient('client-2').size).toBe(0);
    });
  });
});
