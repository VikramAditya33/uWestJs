/**
 * uWestJS - High-performance WebSocket adapter for NestJS
 * @packageDocumentation
 */

// Core adapter
export { UwsAdapter } from './adapter/uws.adapter';

// HTTP Platform Adapter (v2.0.0)
export { UwsPlatformAdapter } from './platform/uws-platform.adapter';

// Decorators
export * from './decorators';

// Middleware
export { UseGuards } from './middleware/guards';
export { UsePipes } from './middleware/pipes';
export { UseFilters } from './middleware/filters';
export type { ModuleRef } from './middleware/module-ref';
export { DefaultModuleRef, NestJsModuleRef } from './middleware/module-ref';

// Exceptions
export * from './exceptions';

// Interfaces
export * from './interfaces';

// Socket wrapper
export { UwsSocketImpl } from './socket/uws-socket';

// Router (for advanced usage)
export { MessageRouter, MetadataScanner, HandlerExecutor } from './router';

// Note: Testing utilities will be exported from 'uwestjs/testing' in Phase 4
