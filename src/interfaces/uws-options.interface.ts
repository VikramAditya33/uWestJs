import * as uWS from 'uWebSockets.js';
import { ModuleRef } from '../middleware/module-ref';

/**
 * CORS configuration options
 * Supports both HTTP and WebSocket CORS
 */
export interface CorsOptions {
  /**
   * Allowed origins
   * - string: single origin (e.g., 'https://example.com')
   * - string[]: multiple origins
   * - boolean: true = allow all (*), false = deny all
   * - function: dynamic origin validation (sync or async)
   * Note: The origin parameter can be null in privacy-sensitive contexts (sandboxed iframes, local files)
   * @example '*' | 'https://example.com' | ['https://example.com', 'https://app.example.com'] | true | false
   */
  origin?: string | string[] | boolean | ((origin: string | null) => boolean | Promise<boolean>);

  /**
   * Allow credentials (cookies, authorization headers, TLS client certificates)
   * @default false
   */
  credentials?: boolean;

  /**
   * Allowed HTTP methods for CORS preflight
   *
   * When not specified, the platform adapter applies context-appropriate defaults:
   * - HTTP context: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']
   * - WebSocket context: ['GET', 'POST']
   *
   * Explicitly setting this field overrides the default for all contexts.
   *
   * @default Context-dependent (see above)
   */
  methods?: string | string[];

  /**
   * Headers that clients are allowed to send
   * @default ['Content-Type', 'Authorization']
   */
  allowedHeaders?: string | string[];

  /**
   * Headers that are exposed to the client
   * @default []
   */
  exposedHeaders?: string | string[];

  /**
   * How long (in seconds) the results of a preflight request can be cached
   * @default 86400 (24 hours)
   */
  maxAge?: number;
}

/**
 * Configuration options for the UwsAdapter
 */
export interface UwsAdapterOptions {
  /**
   * WebSocket server port
   * @default 8099
   */
  port?: number;

  /**
   * Maximum payload length in bytes
   * @default 16384 (16KB)
   */
  maxPayloadLength?: number;

  /**
   * Idle timeout in seconds
   * @default 60
   */
  idleTimeout?: number;

  /**
   * Compression mode
   * @default uWS.SHARED_COMPRESSOR
   */
  compression?: uWS.CompressOptions;

  /**
   * WebSocket endpoint path
   * @default '/*'
   */
  path?: string;

  /**
   * CORS configuration
   */
  cors?: CorsOptions;

  /**
   * Module reference for dependency injection
   *
   * When provided, enables DI support for guards, pipes, and filters.
   * This allows guards/pipes/filters to have constructor dependencies
   * (e.g., ConfigService, JwtService) that will be resolved from the
   * NestJS DI container.
   *
   * Without this, guards/pipes/filters are instantiated directly and
   * cannot have constructor dependencies.
   *
   * @example
   * ```typescript
   * const app = await NestFactory.create(AppModule);
   * const moduleRef = app.get(ModuleRef);
   * app.useWebSocketAdapter(new UwsAdapter(app, {
   *   port: 8099,
   *   moduleRef, // Enable DI for guards/pipes/filters
   * }));
   * ```
   */
  moduleRef?: ModuleRef;

  /**
   * Existing uWS App instance to use
   *
   * **Advanced usage** - This option allows HTTP and WebSocket to share the same uWS server instance.
   *
   * When provided, the adapter will use this existing uWS App instance instead of creating a new one.
   * This enables unified HTTP + WebSocket on a single port, which is the primary use case for
   * UwsPlatformAdapter.
   *
   * **Port Handling**: When `uwsApp` is provided, the `port` option is ignored by this adapter.
   * The external uWS instance controls port binding. You must call `.listen()` on the shared
   * instance separately to bind to a port.
   *
   * @remarks
   * This is an advanced option primarily used internally by UwsPlatformAdapter. External usage
   * is supported but requires careful coordination of the uWS instance lifecycle.
   *
   * **Stability**: This API is stable but requires understanding of uWS lifecycle management.
   *
   * @example
   * ```typescript
   * // Advanced: Share uWS instance between HTTP and WebSocket
   * const uwsApp = uWS.App();
   *
   * // Use for HTTP (port is controlled by platformAdapter.listen())
   * const platformAdapter = new UwsPlatformAdapter({ uwsApp });
   *
   * // Use for WebSocket (shares the same instance, port option ignored)
   * const wsAdapter = new UwsAdapter(app, {
   *   uwsApp, // Same instance
   *   // port is ignored when uwsApp is provided
   * });
   *
   * // Bind to port through the platform adapter
   * await app.listen(3000); // This calls platformAdapter.listen(3000)
   * ```
   *
   * @since 2.0.0
   */
  uwsApp?: uWS.TemplatedApp;
}

/**
 * Resolved adapter options with defaults applied
 * All required fields are guaranteed to have values
 */
export interface ResolvedUwsAdapterOptions {
  /**
   * WebSocket server port
   */
  port: number;

  /**
   * Maximum payload length in bytes
   */
  maxPayloadLength: number;

  /**
   * Idle timeout in seconds
   */
  idleTimeout: number;

  /**
   * Compression mode
   */
  compression: uWS.CompressOptions;

  /**
   * WebSocket endpoint path
   */
  path: string;

  /**
   * CORS configuration
   */
  cors?: CorsOptions;
}
