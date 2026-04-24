import { BroadcastOperator as IBroadcastOperator } from '../interfaces';

/**
 * Broadcast operator implementation for sending messages to multiple clients
 * Supports room targeting and client exclusion with method chaining
 * @template TEmitData - Type of data that can be emitted
 */
export class BroadcastOperator<TEmitData = unknown> implements IBroadcastOperator<TEmitData> {
  private rooms?: string[];
  private excludedClients?: string[];

  constructor(
    private readonly broadcastFn: (
      event: string,
      data: TEmitData | undefined,
      rooms?: string[],
      except?: string[]
    ) => void,
    rooms?: string[],
    excludedClients?: string[]
  ) {
    this.rooms = rooms ? [...rooms] : undefined;
    this.excludedClients = excludedClients ? [...excludedClients] : undefined;
  }

  /**
   * Target specific room(s)
   * @param room - Room name or array of room names
   * @returns New BroadcastOperator for chaining
   * @example
   * ```typescript
   * operator.to('room1').emit('message', data);
   * operator.to(['room1', 'room2']).emit('message', data);
   * operator.to('room1').to('room2').emit('message', data); // Chaining
   * operator.to([]).emit('message', data); // Empty array = broadcast to zero rooms (no clients)
   * ```
   */
  to(room: string | string[]): BroadcastOperator<TEmitData> {
    const combinedRooms = this.mergeArrays(this.rooms, room);
    return new BroadcastOperator(this.broadcastFn, combinedRooms, this.excludedClients);
  }

  /**
   * Exclude specific client(s) from broadcast
   * Multiple except() calls will accumulate excluded clients.
   * @param clientId - Client ID or array of client IDs to exclude
   * @returns New BroadcastOperator for chaining
   * @example
   * ```typescript
   * operator.except('client-1').emit('message', data);
   * operator.except(['client-1', 'client-2']).emit('message', data); // Both excluded
   * operator.to('room1').except('client-1').emit('message', data); // Chaining
   * operator.except('client-1').except('client-2').emit('message', data); // Both excluded (accumulated)
   * operator.except([]).emit('message', data); // Empty array = exclude nobody (no filtering)
   * ```
   */
  except(clientId: string | string[]): BroadcastOperator<TEmitData> {
    const combinedExcluded = this.mergeArrays(this.excludedClients, clientId);
    return new BroadcastOperator(this.broadcastFn, this.rooms, combinedExcluded);
  }

  /**
   * Emit event to all targeted clients
   * @param event - Event name
   * @param data - Optional data to send
   * @example
   * ```typescript
   * operator.emit('message', { text: 'Hello!' });
   * operator.to('room1').emit('notification', { type: 'info' });
   * operator.except('client-1').emit('update', { status: 'active' });
   * ```
   */
  emit(event: string, data?: TEmitData): void {
    this.broadcastFn(event, data, this.rooms, this.excludedClients);
  }

  /**
   * Merge existing array with new items
   * @internal
   */
  private mergeArrays(existing: string[] | undefined, newItems: string | string[]): string[] {
    const itemsArray = Array.isArray(newItems) ? newItems : [newItems];
    return existing ? [...existing, ...itemsArray] : [...itemsArray];
  }
}
