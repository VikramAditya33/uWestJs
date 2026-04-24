import { Logger } from '@nestjs/common';

/**
 * Manages WebSocket rooms and client memberships
 * Provides efficient room-based operations for broadcasting and client management
 */
export class RoomManager {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms: Map<string, Set<string>>; // room -> clientIds
  private readonly clientRooms: Map<string, Set<string>>; // clientId -> rooms

  constructor() {
    this.rooms = new Map();
    this.clientRooms = new Map();
  }

  /**
   * Add a client to one or more rooms
   * @param clientId - The client identifier
   * @param room - Room name or array of room names
   * @example
   * ```typescript
   * roomManager.join('client-123', 'lobby');
   * roomManager.join('client-123', ['game-1', 'chat-general']);
   * ```
   */
  join(clientId: string, room: string | string[]): void {
    if (!clientId) {
      this.logger.warn('Attempted to join with empty clientId');
      return;
    }

    const rooms = Array.isArray(room) ? room : [room];
    const validRooms = rooms.map((r) => r?.trim()).filter((r): r is string => Boolean(r));

    if (validRooms.length === 0) {
      this.logger.warn(`Client ${clientId} attempted to join with no valid rooms`);
      return;
    }

    for (const roomName of validRooms) {
      this.getOrCreateRoomSet(roomName).add(clientId);
      this.getOrCreateClientSet(clientId).add(roomName);
      this.logger.debug(`Client ${clientId} joined room "${roomName}"`);
    }
  }

  /**
   * Remove a client from one or more rooms
   * @param clientId - The client identifier
   * @param room - Room name or array of room names
   * @example
   * ```typescript
   * roomManager.leave('client-123', 'lobby');
   * roomManager.leave('client-123', ['game-1', 'chat-general']);
   * ```
   */
  leave(clientId: string, room: string | string[]): void {
    if (!clientId) {
      this.logger.warn('Attempted to leave with empty clientId');
      return;
    }

    const rooms = Array.isArray(room) ? room : [room];
    const validRooms = rooms.map((r) => r?.trim()).filter((r): r is string => Boolean(r));

    if (validRooms.length === 0) {
      this.logger.warn(`Client ${clientId} attempted to leave with no valid rooms`);
      return;
    }

    for (const roomName of validRooms) {
      this.removeClientFromRoom(clientId, roomName);
      this.removeRoomFromClient(clientId, roomName);
      this.logger.debug(`Client ${clientId} left room "${roomName}"`);
    }
  }

  /**
   * Remove a client from all rooms
   * Typically called when a client disconnects
   * @param clientId - The client identifier
   * @example
   * ```typescript
   * roomManager.leaveAll('client-123');
   * ```
   */
  leaveAll(clientId: string): void {
    if (!clientId) {
      this.logger.warn('Attempted to leaveAll with empty clientId');
      return;
    }

    const clientRoomSet = this.clientRooms.get(clientId);
    if (!clientRoomSet) return;

    for (const roomName of clientRoomSet) {
      this.removeClientFromRoom(clientId, roomName);
    }

    this.clientRooms.delete(clientId);
    this.logger.debug(`Client ${clientId} left all rooms`);
  }

  /**
   * Get all client IDs in a specific room
   * @param room - The room name
   * @returns Set of client IDs in the room (copy to prevent external modification)
   * @example
   * ```typescript
   * const clients = roomManager.getClientsInRoom('lobby');
   * console.log(`${clients.size} clients in lobby`);
   * ```
   */
  getClientsInRoom(room: string): Set<string> {
    const roomClients = this.rooms.get(room?.trim());
    return roomClients ? new Set(roomClients) : new Set();
  }

  /**
   * Get all rooms a client is currently in
   * @param clientId - The client identifier
   * @returns Set of room names the client is in (copy to prevent external modification)
   * @example
   * ```typescript
   * const rooms = roomManager.getRoomsForClient('client-123');
   * console.log(`Client is in: ${Array.from(rooms).join(', ')}`);
   * ```
   */
  getRoomsForClient(clientId: string): Set<string> {
    const clientRoomSet = this.clientRooms.get(clientId);
    return clientRoomSet ? new Set(clientRoomSet) : new Set();
  }

  /**
   * Get the total number of active rooms
   * @returns Number of rooms with at least one client
   * @example
   * ```typescript
   * console.log(`Active rooms: ${roomManager.getRoomCount()}`);
   * ```
   */
  getRoomCount(): number {
    return this.rooms.size;
  }

  /**
   * Get the total number of clients across all rooms
   * Note: A client in multiple rooms is counted once
   * @returns Number of unique clients
   * @example
   * ```typescript
   * console.log(`Total clients: ${roomManager.getClientCount()}`);
   * ```
   */
  getClientCount(): number {
    return this.clientRooms.size;
  }

  /**
   * Check if a client is in a specific room
   * @param clientId - The client identifier
   * @param room - The room name
   * @returns True if the client is in the room
   * @example
   * ```typescript
   * if (roomManager.isClientInRoom('client-123', 'lobby')) {
   *   console.log('Client is in lobby');
   * }
   * ```
   */
  isClientInRoom(clientId: string, room: string): boolean {
    const roomClients = this.rooms.get(room?.trim());
    return roomClients ? roomClients.has(clientId) : false;
  }

  /**
   * Get all active room names
   * @returns Array of room names
   * @example
   * ```typescript
   * const rooms = roomManager.getAllRooms();
   * console.log(`Active rooms: ${rooms.join(', ')}`);
   * ```
   */
  getAllRooms(): string[] {
    return Array.from(this.rooms.keys());
  }

  /**
   * Clear all rooms and client memberships
   * Useful for testing or server reset
   * @example
   * ```typescript
   * roomManager.clear();
   * ```
   */
  clear(): void {
    this.rooms.clear();
    this.clientRooms.clear();
    this.logger.log('All rooms cleared');
  }

  /**
   * Get or create a room's client set
   * @internal
   */
  private getOrCreateRoomSet(roomName: string): Set<string> {
    let roomSet = this.rooms.get(roomName);
    if (!roomSet) {
      roomSet = new Set();
      this.rooms.set(roomName, roomSet);
    }
    return roomSet;
  }

  /**
   * Get or create a client's room set
   * @internal
   */
  private getOrCreateClientSet(clientId: string): Set<string> {
    let clientSet = this.clientRooms.get(clientId);
    if (!clientSet) {
      clientSet = new Set();
      this.clientRooms.set(clientId, clientSet);
    }
    return clientSet;
  }

  /**
   * Remove a client from a room and cleanup if empty
   * @internal
   */
  private removeClientFromRoom(clientId: string, roomName: string): void {
    const roomClients = this.rooms.get(roomName);
    if (!roomClients) return;

    roomClients.delete(clientId);
    if (roomClients.size === 0) {
      this.rooms.delete(roomName);
      this.logger.debug(`Room "${roomName}" is now empty and was removed`);
    }
  }

  /**
   * Remove a room from a client's membership and cleanup if empty
   * @internal
   */
  private removeRoomFromClient(clientId: string, roomName: string): void {
    const clientRoomSet = this.clientRooms.get(clientId);
    if (!clientRoomSet) return;

    clientRoomSet.delete(roomName);
    if (clientRoomSet.size === 0) {
      this.clientRooms.delete(clientId);
    }
  }
}
