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

// HTTP execution context will be exported here in Phase 3
// export { HttpContext } from './http-context';

// Advanced features will be exported here in Phase 4
// export { MultipartHandler } from './multipart-handler';
// export { StaticFileHandler } from './static-file-handler';
