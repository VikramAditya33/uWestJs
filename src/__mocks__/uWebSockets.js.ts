/**
 * Mock for uWebSockets.js
 * Used in tests to avoid loading native modules
 */

// Compression constants
export const SHARED_COMPRESSOR = 0;
export const DEDICATED_COMPRESSOR = 1;
export const DISABLED = 2;

/**
 * Mock WebSocket interface
 */
export interface WebSocket<T = unknown> {
  send(message: string | ArrayBuffer): void;
  close(): void;
  getBufferedAmount(): number;
}

/**
 * Mock TemplatedApp interface
 */
export interface TemplatedApp {
  ws(pattern: string, behavior: unknown): TemplatedApp;
  any(pattern: string, handler: unknown): TemplatedApp;
  listen(port: number, callback: (token: unknown) => void): void;
}

/**
 * Create a mock uWS App
 */
export function App(): TemplatedApp {
  return {
    ws: jest.fn().mockReturnThis(),
    any: jest.fn().mockReturnThis(),
    listen: jest.fn((_port, callback) => callback(true)),
  } as unknown as TemplatedApp;
}

/**
 * Create a mock SSL App (same as regular App in tests)
 */
export const SSLApp = App;

/**
 * Mock function to close a listen socket
 */
export function us_listen_socket_close(_socket: unknown): void {
  // Mock implementation - no-op
}

// Type exports
export type us_listen_socket = unknown;
export type CompressOptions = number;
export type AppOptions = Record<string, unknown>;
