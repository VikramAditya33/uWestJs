/**
 * uWestJS - High-performance WebSocket adapter for NestJS
 * @packageDocumentation
 */

// Core adapter
export { UwsAdapter } from './adapter/uws.adapter';

// Decorators
export * from './decorators';

// Interfaces
export * from './interfaces';

// Socket wrapper
export { UwsSocketImpl } from './socket/uws-socket';

// Router (for advanced usage)
export { MessageRouter, MetadataScanner, HandlerExecutor } from './router';

// Note: Testing utilities will be exported from 'uwestjs/testing' in Phase 4
