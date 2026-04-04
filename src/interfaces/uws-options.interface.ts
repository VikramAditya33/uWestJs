import * as uWS from 'uWebSockets.js';

/**
 * CORS configuration options
 */
export interface CorsOptions {
  /**
   * Allowed origins
   * Can be a string, array of strings, or a function that returns boolean
   * @example '*' | 'https://example.com' | ['https://example.com', 'https://app.example.com']
   */
  origin?: string | string[] | ((origin: string) => boolean);

  /**
   * Allow credentials (cookies, authorization headers, TLS client certificates)
   * @default false
   */
  credentials?: boolean;

  /**
   * Allowed HTTP methods for CORS preflight
   * @default ['GET', 'POST']
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
