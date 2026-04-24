import { BroadcastOperator } from './broadcast-operator';

describe('BroadcastOperator', () => {
  let mockBroadcastFn: jest.Mock;
  let operator: BroadcastOperator;

  beforeEach(() => {
    mockBroadcastFn = jest.fn();
    operator = new BroadcastOperator(mockBroadcastFn);
  });

  describe('emit', () => {
    it('should call broadcastFn with event and various data types', () => {
      operator.emit('test-event', { message: 'hello' });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { message: 'hello' },
        undefined,
        undefined
      );

      mockBroadcastFn.mockClear();
      operator.emit('test-event');
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', undefined, undefined, undefined);

      mockBroadcastFn.mockClear();
      operator.emit('test-event', null);
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', null, undefined, undefined);
    });
  });

  describe('to', () => {
    it('should target single or multiple rooms and chain calls', () => {
      operator.to('room1').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 1 }, ['room1'], undefined);

      mockBroadcastFn.mockClear();
      operator.to(['room1', 'room2']).emit('test-event', { data: 2 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 2 },
        ['room1', 'room2'],
        undefined
      );

      mockBroadcastFn.mockClear();
      operator.to('room1').to('room2').emit('test-event', { data: 3 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 3 },
        ['room1', 'room2'],
        undefined
      );
    });

    it('should return new immutable instances', () => {
      const newOperator = operator.to('room1');
      expect(newOperator).toBeInstanceOf(BroadcastOperator);
      expect(newOperator).not.toBe(operator);
    });
  });

  describe('except', () => {
    it('should exclude clients', () => {
      operator.except('client-1').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 1 }, undefined, [
        'client-1',
      ]);

      mockBroadcastFn.mockClear();
      operator.except(['client-1', 'client-2']).emit('test-event', { data: 2 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 2 }, undefined, [
        'client-1',
        'client-2',
      ]);
    });

    it('should return new immutable instances', () => {
      const newOperator = operator.except('client-1');
      expect(newOperator).toBeInstanceOf(BroadcastOperator);
      expect(newOperator).not.toBe(operator);
    });
  });

  describe('chaining', () => {
    it('should chain to() and except() in any order', () => {
      operator.to('room1').except('client-1').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 1 },
        ['room1'],
        ['client-1']
      );

      mockBroadcastFn.mockClear();
      operator.except('client-1').to('room1').emit('test-event', { data: 2 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 2 },
        ['room1'],
        ['client-1']
      );
    });

    it('should handle complex chaining with multiple calls', () => {
      operator
        .to(['room1', 'room2'])
        .except('client-1')
        .to('room3')
        .except(['client-2', 'client-3'])
        .emit('test-event', { message: 'hello' });

      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { message: 'hello' },
        ['room1', 'room2', 'room3'],
        ['client-1', 'client-2', 'client-3'] // All excluded clients accumulated
      );
    });

    it('should preserve duplicate rooms when chained', () => {
      operator.to('room1').to('room1').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 1 },
        ['room1', 'room1'], // Duplicates preserved (safe: broadcast uses Set for deduplication)
        undefined
      );
    });

    it('should accumulate excluded clients on chained except() calls', () => {
      operator.except('client-1').except('client-2').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 1 },
        undefined,
        ['client-1', 'client-2'] // Both clients accumulated
      );
    });

    it('should preserve duplicate excluded clients when chained', () => {
      operator.except('client-1').except('client-1').emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 1 },
        undefined,
        ['client-1', 'client-1'] // Duplicates preserved (safe: broadcast uses Set for deduplication)
      );
    });
  });

  describe('immutability', () => {
    it('should not modify original operator when chaining', () => {
      const op1 = operator.to('room1');
      const op2 = op1.to('room2');

      op1.emit('event1', { data: 1 });
      op2.emit('event2', { data: 2 });

      expect(mockBroadcastFn).toHaveBeenNthCalledWith(
        1,
        'event1',
        { data: 1 },
        ['room1'],
        undefined
      );
      expect(mockBroadcastFn).toHaveBeenNthCalledWith(
        2,
        'event2',
        { data: 2 },
        ['room1', 'room2'],
        undefined
      );
    });
  });

  describe('constructor with initial state', () => {
    it('should accept initial rooms and excluded clients', () => {
      const op1 = new BroadcastOperator(mockBroadcastFn, ['room1', 'room2']);
      op1.emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 1 },
        ['room1', 'room2'],
        undefined
      );

      mockBroadcastFn.mockClear();
      const op2 = new BroadcastOperator(mockBroadcastFn, ['room1'], ['client-1']);
      op2.emit('test-event', { data: 2 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 2 },
        ['room1'],
        ['client-1']
      );

      mockBroadcastFn.mockClear();
      const op3 = new BroadcastOperator(mockBroadcastFn, undefined, ['client-1', 'client-2']);
      op3.emit('test-event', { data: 3 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 3 }, undefined, [
        'client-1',
        'client-2',
      ]);
    });
  });

  describe('edge cases', () => {
    it('should handle empty arrays and special characters', () => {
      // Empty rooms array means "broadcast to zero rooms" (no clients targeted)
      operator.to([]).emit('test-event', { data: 1 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 1 }, [], undefined);

      mockBroadcastFn.mockClear();
      // Empty except array means "exclude nobody" (no exclusion filter)
      operator.except([]).emit('test-event', { data: 2 });
      expect(mockBroadcastFn).toHaveBeenCalledWith('test-event', { data: 2 }, undefined, []);

      mockBroadcastFn.mockClear();
      operator.to('room:123').except('client-id-with-dashes').emit('test-event', { data: 3 });
      expect(mockBroadcastFn).toHaveBeenCalledWith(
        'test-event',
        { data: 3 },
        ['room:123'],
        ['client-id-with-dashes']
      );
    });
  });
});
