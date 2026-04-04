import { MetadataScanner } from './metadata-scanner';
import 'reflect-metadata';

const MESSAGE_MAPPING_METADATA = 'microservices:message_mapping';

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

  helperMethod() {
    return 'helper';
  }
}

describe('MetadataScanner', () => {
  let scanner: MetadataScanner;
  let gateway: TestGateway;

  const addMetadata = (methodName: keyof TestGateway, message: string | number) => {
    Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, message, TestGateway.prototype[methodName]);
  };

  const clearAllMetadata = () => {
    const methods: (keyof TestGateway)[] = [
      'handleMessage',
      'handleChat',
      'handlePing',
      'helperMethod',
    ];
    methods.forEach((method) => {
      Reflect.deleteMetadata(MESSAGE_MAPPING_METADATA, TestGateway.prototype[method]);
    });
  };

  beforeEach(() => {
    scanner = new MetadataScanner();
    gateway = new TestGateway();
    clearAllMetadata();
  });

  afterEach(() => {
    scanner.clearCache();
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
    it('should cache scan results', () => {
      addMetadata('handleMessage', 'message');

      const firstScan = scanner.scanForMessageHandlers(gateway);
      const secondScan = scanner.scanForMessageHandlers(gateway);

      expect(firstScan).toBe(secondScan);
    });

    it('should return cached results for same instance', () => {
      addMetadata('handleMessage', 'message');

      scanner.scanForMessageHandlers(gateway);

      expect(scanner.getCacheSize()).toBe(1);
    });

    it('should clear cache', () => {
      addMetadata('handleMessage', 'message');

      scanner.scanForMessageHandlers(gateway);
      scanner.clearCache();

      expect(scanner.getCacheSize()).toBe(0);
    });

    it('should scan again after cache clear', () => {
      addMetadata('handleMessage', 'message');

      const firstScan = scanner.scanForMessageHandlers(gateway);
      scanner.clearCache();
      const secondScan = scanner.scanForMessageHandlers(gateway);

      expect(firstScan).not.toBe(secondScan);
      expect(firstScan.length).toBe(secondScan.length);
      expect(firstScan[0].message).toBe(secondScan[0].message);
      expect(firstScan[0].methodName).toBe(secondScan[0].methodName);
    });
  });

  describe('edge cases', () => {
    it('should handle gateway with no methods', () => {
      const emptyGateway = {};
      const handlers = scanner.scanForMessageHandlers(emptyGateway);

      expect(handlers).toEqual([]);
    });

    it('should skip constructor', () => {
      Reflect.defineMetadata(MESSAGE_MAPPING_METADATA, 'constructor', TestGateway.prototype);

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers.map((h) => h.methodName)).not.toContain('constructor');
    });

    it('should handle numeric message patterns', () => {
      addMetadata('handleMessage', 123);

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(1);
      expect(handlers[0].message).toBe(123);
    });

    it('should handle empty string message patterns', () => {
      addMetadata('handleMessage', '');

      const handlers = scanner.scanForMessageHandlers(gateway);

      expect(handlers).toHaveLength(1);
      expect(handlers[0].message).toBe('');
    });
  });
});
