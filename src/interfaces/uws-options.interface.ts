import * as uWS from 'uWebSockets.js';

/**
 * CORS configuration options
 */
export interface CorsOptions {
  /**
   * Allowed origins
   */
  origin?: string | string[];

  /**
   * Allow credentials
   */
  credentials?: boolean;
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
}

/**
 * Resolved adapter options with defaults applied
 * All required fields are guaranteed to have values
 */
export interface ResolvedUwsAdapterOptions {
  port: number;
  maxPayloadLength: number;
  idleTimeout: number;
  compression: uWS.CompressOptions;
  path: string;
  cors?: CorsOptions;
}
