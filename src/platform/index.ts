/**
 * HTTP Platform Adapter (v2.0.0)
 * @module platform
 */

// Platform adapter
export { UwsPlatformAdapter } from './uws-platform.adapter';

// Request/Response wrappers
export { UwsRequest } from './uws-request';
export { UwsResponse, HIGH_WATERMARK } from './uws-response';
export type { CookieOptions } from './uws-response';

// Body parser
export { BodyParser, BUFFER_WATERMARK } from './body-parser';

// Route registry
export { RouteRegistry } from './route-registry';
export type { RouteMetadata } from './route-registry';

// HTTP execution context
export { HttpExecutionContext } from './http-context';

// Multipart form data handling
export { MultipartFormHandler } from './multipart-handler';
export type { MultipartHandler, MultipartField } from './multipart-handler';

// Static file serving
export { StaticFileHandler } from './static-file-handler';
export type { StaticFileOptions } from './static-file-handler';
export { FileWorkerPool } from './file-worker-pool';

// CORS support
export { CorsHandler } from './cors-handler';
export type { CorsOptions } from '../interfaces/uws-options.interface';

// Request/response compression
export { CompressionHandler } from './compression-handler';
export type { CompressionOptions } from './compression-handler';
