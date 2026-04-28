import * as uWS from 'uWebSockets.js';
import { ModuleRef } from '../../shared/di';
import { ModuleRef as NestModuleRef } from '@nestjs/core';
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
   * Maximum connection lifetime in minutes
   *
   * Maximum number of minutes a WebSocket connection may remain open before
   * being automatically closed by the server. Set to 0 to disable this feature.
   *
   * This is useful for:
   * - Forcing clients to reconnect periodically (load balancing)
   * - Preventing indefinitely long connections
   * - Ensuring clients get updated connection parameters
   *
   * @default 0 (disabled)
   * @example
   * ```typescript
   * // Close connections after 24 hours
   * maxLifetime: 24 * 60  // 1440 minutes
   *
   * // Close connections after 1 hour
   * maxLifetime: 60
   *
   * // Disable (allow indefinite connections)
   * maxLifetime: 0
   * ```
   */
  maxLifetime?: number;

  /**
   * Compression mode
   *
   * Controls per-message deflate compression for WebSocket messages.
   *
   * Options:
   * - `uWS.DISABLED` - No compression (lowest CPU, highest bandwidth)
   * - `uWS.SHARED_COMPRESSOR` - Shared compressor across connections (balanced)
   * - `uWS.DEDICATED_COMPRESSOR_3KB` to `_256KB` - Dedicated per-connection (highest compression)
   *
   * @default uWS.SHARED_COMPRESSOR
   * @example
   * ```typescript
   * // Disable compression for low-latency requirements
   * compression: uWS.DISABLED
   *
   * // Enable shared compression (default, recommended)
   * compression: uWS.SHARED_COMPRESSOR
   *
   * // Maximum compression for bandwidth-constrained environments
   * compression: uWS.DEDICATED_COMPRESSOR_256KB
   * ```
   */
  compression?: uWS.CompressOptions;

  /**
   * WebSocket endpoint path
   * @default '/*'
   */
  path?: string;

  /**
   * Maximum backpressure (buffered bytes) per WebSocket connection
   *
   * When a client is slow to receive data, messages are buffered. If the buffer exceeds this limit:
   * - If `closeOnBackpressureLimit` is true: connection is closed
   * - If `closeOnBackpressureLimit` is false: messages continue to buffer (may cause memory issues)
   *
   * @default 1048576 (1MB)
   * @example
   * ```typescript
   * // Allow 5MB of buffered data per connection
   * maxBackpressure: 5 * 1024 * 1024
   *
   * // Strict limit for memory-constrained environments
   * maxBackpressure: 512 * 1024  // 512KB
   * ```
   */
  maxBackpressure?: number;

  /**
   * Close connection when backpressure limit is exceeded
   *
   * When true, connections that exceed `maxBackpressure` are automatically closed.
   * When false, messages continue to buffer (may cause memory issues with slow clients).
   *
   * @default false
   * @example
   * ```typescript
   * // Protect server from slow clients
   * maxBackpressure: 1024 * 1024,
   * closeOnBackpressureLimit: true
   *
   * // Allow unlimited buffering (use with caution)
   * closeOnBackpressureLimit: false
   * ```
   */
  closeOnBackpressureLimit?: boolean;

  /**
   * Automatically send ping frames to keep connections alive
   *
   * When enabled, the server automatically sends WebSocket ping frames to detect
   * dead connections. Clients must respond with pong frames or the connection
   * will be closed after `idleTimeout` seconds.
   *
   * @default true
   * @example
   * ```typescript
   * // Enable automatic pings (recommended)
   * sendPingsAutomatically: true,
   * idleTimeout: 120  // Close if no pong received within 120s
   *
   * // Disable if client handles pings manually
   * sendPingsAutomatically: false
   * ```
   */
  sendPingsAutomatically?: boolean;

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
   * Accepts either:
   * - NestJS ModuleRef (from `@nestjs/core`) - will be auto-wrapped
   * - Our ModuleRef interface (e.g., `NestJsModuleRef.create(nestModuleRef)`)
   *
   * Without this, guards/pipes/filters are instantiated directly and
   * cannot have constructor dependencies.
   *
   * @example
   * ```typescript
   * import { ModuleRef } from '@nestjs/core';
   *
   * const app = await NestFactory.create(AppModule);
   * const moduleRef = app.get(ModuleRef);
   *
   * // Simple usage - pass NestJS ModuleRef directly (auto-wrapped)
   * app.useWebSocketAdapter(new UwsAdapter(app, {
   *   port: 8099,
   *   moduleRef, // Auto-wrapped internally
   * }));
   * ```
   */
  moduleRef?: ModuleRef | NestModuleRef;

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
   * Maximum connection lifetime in minutes
   */
  maxLifetime: number;

  /**
   * Compression mode
   */
  compression: uWS.CompressOptions;

  /**
   * WebSocket endpoint path
   */
  path: string;

  /**
   * Maximum backpressure (buffered bytes) per WebSocket connection
   */
  maxBackpressure: number;

  /**
   * Close connection when backpressure limit is exceeded
   */
  closeOnBackpressureLimit: boolean;

  /**
   * Automatically send ping frames to keep connections alive
   */
  sendPingsAutomatically: boolean;

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
