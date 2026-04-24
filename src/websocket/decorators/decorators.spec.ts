import 'reflect-metadata';
import { MessageBody } from './message-body.decorator';
import { ConnectedSocket } from './connected-socket.decorator';
import { Payload } from './payload.decorator';
import { PARAM_ARGS_METADATA, ParamType } from './param-decorator.utils';
import type { ParamMetadata } from './param-decorator.utils';

/**
 * Helper to get parameter metadata for a method
 */
function getParamMetadata(target: object, methodName: string): ParamMetadata[] {
  return Reflect.getMetadata(PARAM_ARGS_METADATA, target, methodName) || [];
}

/**
 * Helper to apply decorators to a test class
 */
function applyDecorators() {
  class TestGateway {
    handleWithMessageBody(data: unknown) {
      return data;
    }

    handleWithMessageBodyProperty(text: string) {
      return text;
    }

    handleWithSocket(client: unknown) {
      return client;
    }

    handleWithPayload(data: unknown) {
      return data;
    }

    handleWithPayloadProperty(message: string) {
      return message;
    }

    handleWithMultiple(client: unknown, data: unknown) {
      return { client, data };
    }

    handleWithMixed(client: unknown, text: string, user: string) {
      return { client, text, user };
    }
  }

  // Apply decorators manually
  MessageBody()(TestGateway.prototype, 'handleWithMessageBody', 0);
  MessageBody('text')(TestGateway.prototype, 'handleWithMessageBodyProperty', 0);
  ConnectedSocket()(TestGateway.prototype, 'handleWithSocket', 0);
  Payload()(TestGateway.prototype, 'handleWithPayload', 0);
  Payload('message')(TestGateway.prototype, 'handleWithPayloadProperty', 0);

  ConnectedSocket()(TestGateway.prototype, 'handleWithMultiple', 0);
  MessageBody()(TestGateway.prototype, 'handleWithMultiple', 1);

  ConnectedSocket()(TestGateway.prototype, 'handleWithMixed', 0);
  MessageBody('text')(TestGateway.prototype, 'handleWithMixed', 1);
  Payload('user')(TestGateway.prototype, 'handleWithMixed', 2);

  return TestGateway;
}

describe('Parameter Decorators', () => {
  let TestGateway: ReturnType<typeof applyDecorators>;

  beforeAll(() => {
    TestGateway = applyDecorators();
  });

  describe('@MessageBody', () => {
    it('should store parameter metadata with optional property name', () => {
      const fullMetadata = getParamMetadata(TestGateway.prototype, 'handleWithMessageBody');
      expect(fullMetadata).toHaveLength(1);
      expect(fullMetadata[0]).toEqual({
        index: 0,
        type: ParamType.MESSAGE_BODY,
        // Note: data property is omitted when no property name is provided
      });

      const propertyMetadata = getParamMetadata(
        TestGateway.prototype,
        'handleWithMessageBodyProperty'
      );
      expect(propertyMetadata).toHaveLength(1);
      expect(propertyMetadata[0]).toEqual({
        index: 0,
        type: ParamType.MESSAGE_BODY,
        data: 'text',
      });
    });

    it('should store correct parameter index', () => {
      const metadata = getParamMetadata(TestGateway.prototype, 'handleWithMultiple');
      const messageBodyParam = metadata.find((m) => m.type === ParamType.MESSAGE_BODY);

      expect(messageBodyParam?.index).toBe(1);
    });
  });

  describe('@ConnectedSocket', () => {
    it('should store parameter metadata', () => {
      const metadata = getParamMetadata(TestGateway.prototype, 'handleWithSocket');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.CONNECTED_SOCKET,
      });
    });

    it('should store correct parameter index', () => {
      const metadata = getParamMetadata(TestGateway.prototype, 'handleWithMultiple');
      const socketParam = metadata.find((m) => m.type === ParamType.CONNECTED_SOCKET);

      expect(socketParam?.index).toBe(0);
    });
  });

  describe('@Payload', () => {
    it('should store parameter metadata with optional property name', () => {
      const fullMetadata = getParamMetadata(TestGateway.prototype, 'handleWithPayload');
      expect(fullMetadata).toHaveLength(1);
      expect(fullMetadata[0]).toEqual({
        index: 0,
        type: ParamType.PAYLOAD,
        // Note: data property is omitted when no property name is provided
      });

      const propertyMetadata = getParamMetadata(TestGateway.prototype, 'handleWithPayloadProperty');
      expect(propertyMetadata).toHaveLength(1);
      expect(propertyMetadata[0]).toEqual({
        index: 0,
        type: ParamType.PAYLOAD,
        data: 'message',
      });
    });
  });

  describe('Multiple decorators', () => {
    it('should store metadata for all decorated parameters', () => {
      const metadata = getParamMetadata(TestGateway.prototype, 'handleWithMultiple');
      expect(metadata).toHaveLength(2);
    });

    it('should store metadata for mixed decorators', () => {
      const metadata = getParamMetadata(TestGateway.prototype, 'handleWithMixed');

      expect(metadata).toHaveLength(3);

      const socketParam = metadata.find((m) => m.type === ParamType.CONNECTED_SOCKET);
      const messageBodyParam = metadata.find((m) => m.type === ParamType.MESSAGE_BODY);
      const payloadParam = metadata.find((m) => m.type === ParamType.PAYLOAD);

      expect(socketParam).toEqual({ index: 0, type: ParamType.CONNECTED_SOCKET });
      expect(messageBodyParam).toEqual({ index: 1, type: ParamType.MESSAGE_BODY, data: 'text' });
      expect(payloadParam).toEqual({ index: 2, type: ParamType.PAYLOAD, data: 'user' });
    });

    it('should throw error when applying multiple decorators to same parameter', () => {
      class TestClass {
        testMethod(param: unknown) {
          return param;
        }
      }

      // Apply first decorator
      MessageBody()(TestClass.prototype, 'testMethod', 0);

      // Attempt to apply second decorator to same parameter should throw
      expect(() => {
        ConnectedSocket()(TestClass.prototype, 'testMethod', 0);
      }).toThrow(
        'ConnectedSocket decorator: parameter at index 0 already has @MessageBody decorator applied'
      );
    });
  });
});
