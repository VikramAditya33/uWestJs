/**
 * WebSocket compression constants re-exported from uWebSockets.js
 * @packageDocumentation
 */

import * as uWS from 'uWebSockets.js';

/**
 * Compression and decompression mode constants for WebSocket connections
 *
 * @example
 * ```typescript
 * import { UwsAdapter, SHARED_COMPRESSOR, DISABLED } from 'uwestjs';
 *
 * new UwsAdapter(app, { compression: SHARED_COMPRESSOR });
 * ```
 */

/**
 * No compression - lowest CPU usage, highest bandwidth
 */
export const DISABLED = uWS.DISABLED;

/**
 * Shared compressor across all connections - balanced performance (recommended)
 */
export const SHARED_COMPRESSOR = uWS.SHARED_COMPRESSOR;

/**
 * Shared decompressor across all connections
 */
export const SHARED_DECOMPRESSOR = uWS.SHARED_DECOMPRESSOR;

/**
 * Dedicated 3KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_3KB = uWS.DEDICATED_COMPRESSOR_3KB;

/**
 * Dedicated 4KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_4KB = uWS.DEDICATED_COMPRESSOR_4KB;

/**
 * Dedicated 8KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_8KB = uWS.DEDICATED_COMPRESSOR_8KB;

/**
 * Dedicated 16KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_16KB = uWS.DEDICATED_COMPRESSOR_16KB;

/**
 * Dedicated 32KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_32KB = uWS.DEDICATED_COMPRESSOR_32KB;

/**
 * Dedicated 64KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_64KB = uWS.DEDICATED_COMPRESSOR_64KB;

/**
 * Dedicated 128KB compressor per connection
 */
export const DEDICATED_COMPRESSOR_128KB = uWS.DEDICATED_COMPRESSOR_128KB;

/**
 * Dedicated 256KB compressor per connection - highest compression, highest memory
 */
export const DEDICATED_COMPRESSOR_256KB = uWS.DEDICATED_COMPRESSOR_256KB;

/**
 * Dedicated 512B decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_512B = uWS.DEDICATED_DECOMPRESSOR_512B;

/**
 * Dedicated 1KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_1KB = uWS.DEDICATED_DECOMPRESSOR_1KB;

/**
 * Dedicated 2KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_2KB = uWS.DEDICATED_DECOMPRESSOR_2KB;

/**
 * Dedicated 4KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_4KB = uWS.DEDICATED_DECOMPRESSOR_4KB;

/**
 * Dedicated 8KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_8KB = uWS.DEDICATED_DECOMPRESSOR_8KB;

/**
 * Dedicated 16KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_16KB = uWS.DEDICATED_DECOMPRESSOR_16KB;

/**
 * Dedicated 32KB decompressor per connection
 */
export const DEDICATED_DECOMPRESSOR_32KB = uWS.DEDICATED_DECOMPRESSOR_32KB;

/**
 * uWebSockets.js App factory functions
 *
 * @example
 * ```typescript
 * import { App, SSLApp } from 'uwestjs';
 *
 * // Create HTTP app
 * const app = App();
 *
 * // Create HTTPS app
 * const sslApp = SSLApp({
 *   key_file_name: 'key.pem',
 *   cert_file_name: 'cert.pem'
 * });
 * ```
 */

/**
 * Create a non-SSL uWebSockets.js app instance
 */
export const App = uWS.App;

/**
 * Create an SSL-enabled uWebSockets.js app instance
 */
export const SSLApp = uWS.SSLApp;
