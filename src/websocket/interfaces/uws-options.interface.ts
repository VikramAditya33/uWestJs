import * as uWS from 'uWebSockets.js';
import { ModuleRef } from '../../shared/di';
import { CorsOptions } from '../../shared/interfaces';

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

  /**
   * SSL/TLS certificate file path
   * Must be provided together with key_file_name for HTTPS/WSS
   */
  cert_file_name?: string;

  /**
   * SSL/TLS private key file path
   * Must be provided together with cert_file_name for HTTPS/WSS
   */
  key_file_name?: string;

  /**
   * Optional passphrase for the private key
   */
  passphrase?: string;

  /**
   * Optional Diffie-Hellman parameters file path
   */
  dh_params_file_name?: string;

  /**
   * Prefer low memory usage for SSL (may reduce performance)
   * @default false
   */
  ssl_prefer_low_memory_usage?: boolean;
}

/**
 * Resolved adapter options with defaults applied
 * All required fields are guaranteed to have values
 *
 * Note: When uwsApp is provided to UwsAdapterOptions, the port field
 * receives a default value during resolution but is ignored during
 * server initialization since the external uwsApp controls port binding.
 */
export interface ResolvedUwsAdapterOptions {
  /**
   * WebSocket server port
   * Ignored when uwsApp is provided to UwsAdapterOptions
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

  /**
   * SSL/TLS certificate file path
   * Only present when both cert and key are provided
   */
  cert_file_name?: string;

  /**
   * SSL/TLS private key file path
   * Only present when both cert and key are provided
   */
  key_file_name?: string;

  /**
   * Optional passphrase for the private key
   */
  passphrase?: string;

  /**
   * Optional Diffie-Hellman parameters file path
   */
  dh_params_file_name?: string;

  /**
   * Prefer low memory usage for SSL (may reduce performance)
   */
  ssl_prefer_low_memory_usage?: boolean;
}
