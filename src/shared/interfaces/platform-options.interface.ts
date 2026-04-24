import { UwsAdapterOptions } from '../../websocket/interfaces';
import { HttpOptions } from '../../http/interfaces';

/**
 * Unified options for HTTP + WebSocket platform adapter
 * Combines WebSocket options (v1.x) with new HTTP options (v2.0.0)
 *
 * Uses type alias for pure composition without adding new properties.
 * Both HTTP and WebSocket share the same uWS instance and CORS configuration.
 */
export type PlatformOptions = UwsAdapterOptions & HttpOptions;
