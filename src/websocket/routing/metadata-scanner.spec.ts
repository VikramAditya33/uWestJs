import { MetadataScanner } from './metadata-scanner';
import 'reflect-metadata';

const MESSAGE_MAPPING_METADATA = 'websockets:message_mapping';
const MESSAGE_METADATA = 'message';

class TestGateway {
  handleMessage() {
    return 'message handled';
  }

  handleChat() {
    return 'chat handled';
  }

  handlePing() {
    return 'pong';
  }

  handleError() {
    return 'error';
  }

  helperMethod() {
    return 'helper';
  }
}

describe('MetadataScanner', () => {
  let scanner: MetadataScanner;
  let gateway: TestGateway;

  const addMetadata = (methodName: keyof TestGateway, message: unknown) => {
    const method = TestGateway.prototype[methodName];
    Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, method);
    Reflect.defineMetadata(MESSAGE_METADATA, message, method);
  };

  const clearAllMetadata = () => {
    const methods: (keyof TestGateway)[] = [
      'handleMessage',
      'handleChat',
      'handlePing',
      'handleError',
      'helperMethod',
    ];
    methods.forEach((method) => {
      const methodRef = TestGateway.prototype[method];
      Reflect.deleteMetadata(MESSAGE_MAPPING_METADATA, methodRef);
      Reflect.deleteMetadata(MESSAGE_METADATA, methodRef);
    });
  };

  beforeEach(() => {
    scanner = new MetadataScanner();
    gateway = new TestGateway();
    clearAllMetadata();
  });

  describe('scanForMessageHandlers', () => {
    it('should discover methods with @SubscribeMessage metadata', () => {
      addMetadata('handleMessage', 'message');
      addMetadata('handleChat', 'chat');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(2);
      expect(handlers.map((h) => h.message)).toContain('message');
      expect(handlers.map((h) => h.message)).toContain('chat');
    });

    it('should include method names in handlers', () => {
      addMetadata('handleMessage', 'message');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers[0].methodName).toBe('handleMessage');
    });

    it('should bind callbacks to the gateway instance', () => {
      addMetadata('handleMessage', 'message');

      const handlers = scanner.scanForMessageHandlers(gateway);
      const result = handlers[0].callback();

      expect(result).toBe('message handled');
    });

    it('should not include methods without metadata', () => {
      addMetadata('handleMessage', 'message');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(1);
      expect(handlers.map((h) => h.methodName)).not.toContain('helperMethod');
    });

    it('should return empty array when no handlers found', () => {
      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toEqual([]);
    });

    it('should handle multiple message patterns', () => {
      addMetadata('handleMessage', 'message');
      addMetadata('handleChat', 'chat');
      addMetadata('handlePing', 'ping');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(3);
      expect(handlers.map((h) => h.message)).toEqual(
        expect.arrayContaining(['message', 'chat', 'ping'])
      );
    });
  });

  describe('caching', () => {
    it('should cache scan results for same instance', () => {
      addMetadata('handleMessage', 'message');

      const firstScan = scanner.scanForMessageHandlers(gateway);
      const secondScan = scanner.scanForMessageHandlers(gateway);

      expect(firstScan).toBe(secondScan);
    });

    it('should not share cache between different instances', () => {
      addMetadata('handleMessage', 'message');

      const gateway1 = new TestGateway();
      const gateway2 = new TestGateway();

      const scan1 = scanner.scanForMessageHandlers(gateway1);
      const scan2 = scanner.scanForMessageHandlers(gateway2);

      expect(scan1).not.toBe(scan2);
      expect(scan1.length).toBe(scan2.length);
    });
  });

  describe('getMethodNameForEvent', () => {
    it('should return method name for existing event', () => {
      addMetadata('handleMessage', 'message');
      addMetadata('handleChat', 'chat');

      scanner.scanForMessageHandlers(gateway);

      expect(scanner.getMethodNameForEvent(gateway, 'message')).toBe('handleMessage');
      expect(scanner.getMethodNameForEvent(gateway, 'chat')).toBe('handleChat');
    });

    it('should return method name for object pattern events', () => {
      const pattern = { cmd: 'test', version: 1 };
      addMetadata('handleMessage', pattern);

      scanner.scanForMessageHandlers(gateway);

      expect(scanner.getMethodNameForEvent(gateway, pattern)).toBe('handleMessage');
    });

    it('should match object patterns with keys in different order', () => {
      const pattern = { cmd: 'test', id: 123 };
      addMetadata('handleMessage', pattern);

      scanner.scanForMessageHandlers(gateway);

      // Same pattern but keys in different order
      expect(scanner.getMethodNameForEvent(gateway, { id: 123, cmd: 'test' })).toBe(
        'handleMessage'
      );
    });

    it('should match nested object patterns with keys in different order', () => {
      const pattern = { cmd: 'test', meta: { version: 1, type: 'request' } };
      addMetadata('handleMessage', pattern);

      scanner.scanForMessageHandlers(gateway);

      // Same pattern but keys in different order at all levels
      expect(
        scanner.getMethodNameForEvent(gateway, {
          meta: { type: 'request', version: 1 },
          cmd: 'test',
        })
      ).toBe('handleMessage');
    });

    it('should return null for non-existent event', () => {
      addMetadata('handleMessage', 'message');

      scanner.scanForMessageHandlers(gateway);

      expect(scanner.getMethodNameForEvent(gateway, 'unknown')).toBeNull();
    });

    it('should return null for uncached instance', () => {
      const uncachedGateway = new TestGateway();

      expect(scanner.getMethodNameForEvent(uncachedGateway, 'message')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle gateway with no methods', () => {
      const emptyGateway = {};
      const handlers = scanner.scanForMessageHandlers(emptyGateway);

      expect(handlers).toEqual([]);
    });

    it('should skip constructor and invalid message pattern types', () => {
      addMetadata('handleMessage', 'valid-string');
      addMetadata('handleChat', 123); // Invalid: number
      addMetadata('handlePing', ['array']); // Invalid: array
      addMetadata('handleError', null); // Invalid: null

      // Try to add metadata to the constructor (shouldn't be picked up)
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, TestGateway.prototype.constructor);
      Reflect.defineMetadata(MESSAGE_METADATA, 'test', TestGateway.prototype.constructor);

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(1);
      expect(handlers[0].methodName).toBe('handleMessage');
      expect(handlers[0].message).toBe('valid-string');
    });

    it('should accept object and empty string message patterns', () => {
      const objectPattern = { cmd: 'test', version: 1 };
      addMetadata('handleMessage', objectPattern);
      addMetadata('handleChat', '');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(2);
      expect(handlers.find((h) => h.methodName === 'handleMessage')?.message).toEqual(
        objectPattern
      );
      expect(handlers.find((h) => h.methodName === 'handleChat')?.message).toBe('');
    });
  });

  describe('inheritance support', () => {
    class BaseGateway {
      handleBase() {
        return 'base handled';
      }

      handleShared() {
        return 'base shared';
      }
    }

    class ChildGateway extends BaseGateway {
      handleChild() {
        return 'child handled';
      }

      // Override parent method
      handleShared() {
        return 'child shared';
      }
    }

    // Clean up metadata before each test
    beforeEach(() => {
      // Clear metadata from all methods
      [BaseGateway.prototype.handleBase, BaseGateway.prototype.handleShared].forEach((method) => {
        Reflect.deleteMetadata(MESSAGE_MAPPING_METADATA, method);
        Reflect.deleteMetadata(MESSAGE_METADATA, method);
      });
      [ChildGateway.prototype.handleChild, ChildGateway.prototype.handleShared].forEach(
        (method) => {
          Reflect.deleteMetadata(MESSAGE_MAPPING_METADATA, method);
          Reflect.deleteMetadata(MESSAGE_METADATA, method);
        }
      );
    });

    it('should discover handlers from parent classes', () => {
      // Add metadata to base class method
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, BaseGateway.prototype.handleBase);
      Reflect.defineMetadata(MESSAGE_METADATA, 'base', BaseGateway.prototype.handleBase);
      // Add metadata to child class method
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, ChildGateway.prototype.handleChild);
      Reflect.defineMetadata(MESSAGE_METADATA, 'child', ChildGateway.prototype.handleChild);

      const childGateway = new ChildGateway();
      const handlers = scanner.scanForMessageHandlers(childGateway);

      expect(handlers).toHaveLength(2);
      expect(handlers.map((h) => h.message)).toContain('base');
      expect(handlers.map((h) => h.message)).toContain('child');
    });

    it('should bind inherited methods to child instance', () => {
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, BaseGateway.prototype.handleBase);
      Reflect.defineMetadata(MESSAGE_METADATA, 'base', BaseGateway.prototype.handleBase);

      const childGateway = new ChildGateway();
      const handlers = scanner.scanForMessageHandlers(childGateway);

      const baseHandler = handlers.find((h) => h.message === 'base');
      expect(baseHandler).toBeDefined();
      expect(baseHandler!.callback()).toBe('base handled');
    });

    it('should handle method overrides correctly', () => {
      // Add metadata to the overridden method in child class
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, ChildGateway.prototype.handleShared);
      Reflect.defineMetadata(MESSAGE_METADATA, 'shared', ChildGateway.prototype.handleShared);

      const childGateway = new ChildGateway();
      const handlers = scanner.scanForMessageHandlers(childGateway);

      const sharedHandler = handlers.find((h) => h.message === 'shared');
      expect(sharedHandler).toBeDefined();
      // Should call the child's version, not the parent's
      expect(sharedHandler!.callback()).toBe('child shared');
    });

    it('should not duplicate methods from inheritance chain', () => {
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, BaseGateway.prototype.handleBase);
      Reflect.defineMetadata(MESSAGE_METADATA, 'base', BaseGateway.prototype.handleBase);
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, true, ChildGateway.prototype.handleChild);
      Reflect.defineMetadata(MESSAGE_METADATA, 'child', ChildGateway.prototype.handleChild);

      const childGateway = new ChildGateway();
      const handlers = scanner.scanForMessageHandlers(childGateway);

      expect(handlers).toHaveLength(2);
      const methodNames = handlers.map((h) => h.methodName);
      expect(new Set(methodNames).size).toBe(methodNames.length);
      expect(methodNames).toContain('handleBase');
      expect(methodNames).toContain('handleChild');

      // Verify handleBase only appears once
      const baseHandlers = handlers.filter((h) => h.methodName === 'handleBase');
      expect(baseHandlers).toHaveLength(1);
    });
  });
});
