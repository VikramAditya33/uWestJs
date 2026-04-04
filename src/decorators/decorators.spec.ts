import 'reflect-metadata';
import { MessageBody } from './message-body.decorator';
import { ConnectedSocket } from './connected-socket.decorator';
import { Payload } from './payload.decorator';
import { PARAM_ARGS_METADATA, ParamMetadata, ParamType } from './message-body.decorator';

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
    it('should store parameter metadata', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMessageBody');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.MESSAGE_BODY,
        data: undefined,
      });
    });

    it('should store property name when provided', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMessageBodyProperty');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.MESSAGE_BODY,
        data: 'text',
      });
    });

    it('should store correct parameter index', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMultiple');
      const messageBodyParam = metadata.find((m) => m.type === ParamType.MESSAGE_BODY);

      expect(messageBodyParam?.index).toBe(1);
    });
  });

  describe('@ConnectedSocket', () => {
    it('should store parameter metadata', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithSocket');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.CONNECTED_SOCKET,
      });
    });

    it('should store correct parameter index', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMultiple');
      const socketParam = metadata.find((m) => m.type === ParamType.CONNECTED_SOCKET);

      expect(socketParam?.index).toBe(0);
    });
  });

  describe('@Payload', () => {
    it('should store parameter metadata', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithPayload');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.PAYLOAD,
        data: undefined,
      });
    });

    it('should store property name when provided', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithPayloadProperty');

      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toEqual({
        index: 0,
        type: ParamType.PAYLOAD,
        data: 'message',
      });
    });
  });

  describe('Multiple decorators', () => {
    it('should store metadata for all decorated parameters', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMultiple');
      expect(metadata).toHaveLength(2);
    });

    it('should store metadata for mixed decorators', () => {
      const metadata = getParamMetadata(TestGateway, 'handleWithMixed');

      expect(metadata).toHaveLength(3);

      const socketParam = metadata.find((m) => m.type === ParamType.CONNECTED_SOCKET);
      const messageBodyParam = metadata.find((m) => m.type === ParamType.MESSAGE_BODY);
      const payloadParam = metadata.find((m) => m.type === ParamType.PAYLOAD);

      expect(socketParam).toEqual({ index: 0, type: ParamType.CONNECTED_SOCKET });
      expect(messageBodyParam).toEqual({ index: 1, type: ParamType.MESSAGE_BODY, data: 'text' });
      expect(payloadParam).toEqual({ index: 2, type: ParamType.PAYLOAD, data: 'user' });
    });
  });
});
