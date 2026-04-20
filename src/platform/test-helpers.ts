/**
 * Shared test utilities for platform tests
 */

/**
 * Convert Buffer to ArrayBuffer (simulating uWS behavior)
 *
 * Uses Buffer's underlying ArrayBuffer with slice to create a proper copy.
 * This is more idiomatic than manually copying bytes via Uint8Array.
 *
 * Note: Buffer.buffer can be either ArrayBuffer or SharedArrayBuffer.
 * We cast to ArrayBuffer since slice() returns the same type and we're
 * only using this in tests where we control the Buffer creation.
 *
 * Used in tests to simulate uWebSockets.js ArrayBuffer chunks.
 */
export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}
