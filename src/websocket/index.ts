// Core WebSocket primitives
export { UwsSocketImpl, BroadcastOperator } from './core';

// Rooms
export * from './rooms';

// Routing
export * from './routing';

// Decorators
export * from './decorators';

// Middleware (guards, pipes, filters)
export * from './middleware';

// Adapter
export * from './adapter';

// Exceptions
export * from './exceptions';

// Interfaces (types only, BroadcastOperator class takes precedence)
export type {
  UwsSocket,
  BroadcastOperator as IBroadcastOperator,
} from './interfaces/uws-socket.interface';
export type {
  UwsAdapterOptions,
  ResolvedUwsAdapterOptions,
} from './interfaces/uws-options.interface';
export type { WebSocketClient } from './interfaces/websocket-client.interface';
