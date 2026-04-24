import * as zlib from 'zlib';
import { Transform } from 'stream';
import { CompressionHandler } from './compression-handler';
import { UwsRequest } from '../../core/request';
import { UwsResponse } from '../../core/response';

describe('CompressionHandler', () => {
  let mockReq: Partial<UwsRequest>;
  let mockRes: Partial<UwsResponse>;
  let setHeaderSpy: jest.Mock;
  let getHeaderSpy: jest.Mock;

  const SMALL_DATA = Buffer.from('Hello, World!');
  const LARGE_DATA = Buffer.from('Hello, World!'.repeat(100));

  const setupMock = (acceptEncoding?: string, contentType?: string, contentEncoding?: string) => {
    (mockReq as any).headers = acceptEncoding ? { 'accept-encoding': acceptEncoding } : {};
    getHeaderSpy.mockImplementation((name) => {
      if (name === 'content-type') return contentType;
      if (name === 'content-encoding') return contentEncoding;
      return undefined;
    });
  };

  const verifyDecompression = (
    compressed: Buffer,
    original: Buffer,
    method: 'gzip' | 'deflate' | 'brotli'
  ) => {
    const decompressed =
      method === 'gzip'
        ? zlib.gunzipSync(compressed)
        : method === 'deflate'
          ? zlib.inflateSync(compressed)
          : zlib.brotliDecompressSync(compressed);
    expect(decompressed.toString()).toBe(original.toString());
  };

  beforeEach(() => {
    setHeaderSpy = jest.fn();
    getHeaderSpy = jest.fn().mockReturnValue(undefined);
    mockReq = { headers: {} };
    mockRes = {
      setHeader: setHeaderSpy,
      getHeader: getHeaderSpy,
      removeHeader: jest.fn(),
    };
  });

  describe('Request Decompression', () => {
    it.each([
      ['gzip', 'gzip', (data: Buffer) => zlib.gzipSync(data)],
      ['deflate', 'deflate', (data: Buffer) => zlib.deflateSync(data)],
      ['brotli', 'br', (data: Buffer) => zlib.brotliCompressSync(data)],
    ])('should decompress %s request body', async (_name, encoding, compressFn) => {
      const handler = new CompressionHandler();
      const compressed = compressFn(SMALL_DATA);
      (mockReq as any).headers = { 'content-encoding': encoding };

      const result = await handler.decompressRequest(mockReq as UwsRequest, compressed);

      expect(result.toString()).toBe(SMALL_DATA.toString());
    });

    it.each([
      ['no content-encoding', {}],
      ['identity encoding', { 'content-encoding': 'identity' }],
      ['unknown encoding', { 'content-encoding': 'unknown' }],
    ])('should return original body with %s', async (_name, headers) => {
      const handler = new CompressionHandler();
      (mockReq as any).headers = headers;

      const result = await handler.decompressRequest(mockReq as UwsRequest, SMALL_DATA);

      expect(result).toBe(SMALL_DATA);
    });

    it('should return original body if inflate is disabled', async () => {
      const handler = new CompressionHandler({ inflate: false });
      const compressed = zlib.gzipSync(SMALL_DATA);
      (mockReq as any).headers = { 'content-encoding': 'gzip' };

      const result = await handler.decompressRequest(mockReq as UwsRequest, compressed);

      expect(result).toBe(compressed);
    });

    it('should handle array content-encoding header', async () => {
      const handler = new CompressionHandler();
      const compressed = zlib.gzipSync(SMALL_DATA);
      (mockReq as any).headers = { 'content-encoding': ['gzip', 'other'] as any };

      const result = await handler.decompressRequest(mockReq as UwsRequest, compressed);

      expect(result.toString()).toBe(SMALL_DATA.toString());
    });

    it('should handle multiple encodings in correct order', async () => {
      const handler = new CompressionHandler();
      // Apply gzip first, then deflate (so Content-Encoding: gzip, deflate)
      const gzipped = zlib.gzipSync(SMALL_DATA);
      const doubleCompressed = zlib.deflateSync(gzipped);
      (mockReq as any).headers = { 'content-encoding': 'gzip, deflate' };

      const result = await handler.decompressRequest(mockReq as UwsRequest, doubleCompressed);

      // Should decompress in reverse order: deflate first, then gzip
      expect(result.toString()).toBe(SMALL_DATA.toString());
    });

    it('should throw error on invalid gzip data', async () => {
      const handler = new CompressionHandler();
      (mockReq as any).headers = { 'content-encoding': 'gzip' };

      await expect(
        handler.decompressRequest(mockReq as UwsRequest, Buffer.from('invalid'))
      ).rejects.toThrow(/Failed to decompress request body/);
    });

    it('should reject decompression bomb (exceeds size limit)', async () => {
      const handler = new CompressionHandler({ maxInflatedBodySize: 1024 }); // 1KB limit
      // Create a highly compressible payload that expands way beyond limit
      const largeData = Buffer.alloc(100 * 1024, 'A'); // 100KB of 'A's (compresses to ~1KB)
      const compressed = zlib.gzipSync(largeData);
      (mockReq as any).headers = { 'content-encoding': 'gzip' };

      await expect(handler.decompressRequest(mockReq as UwsRequest, compressed)).rejects.toThrow(
        /Decompressed body size.*exceeds limit/
      );
    });

    it('should allow decompression within size limit', async () => {
      const handler = new CompressionHandler({ maxInflatedBodySize: 2048 }); // 2KB limit
      const data = Buffer.alloc(1024, 'A'); // 1KB of data
      const compressed = zlib.gzipSync(data);
      (mockReq as any).headers = { 'content-encoding': 'gzip' };

      const result = await handler.decompressRequest(mockReq as UwsRequest, compressed);

      expect(result.length).toBe(1024);
      expect(result.toString()).toBe(data.toString());
    });
  });

  describe('Response Compression - Streaming', () => {
    describe('createCompressionStream', () => {
      it('should create gzip compression stream', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
        expect(setHeaderSpy).toHaveBeenCalledWith('vary', 'Accept-Encoding');
      });

      it('should append to existing Vary header', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');
        getHeaderSpy.mockImplementation((name) => {
          if (name === 'content-type') return 'text/plain';
          if (name === 'vary') return 'Origin';
          return undefined;
        });

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('vary', 'Origin, Accept-Encoding');
      });

      it('should not duplicate Accept-Encoding in Vary header', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');
        getHeaderSpy.mockImplementation((name) => {
          if (name === 'content-type') return 'text/plain';
          if (name === 'vary') return 'Accept-Encoding, Origin';
          return undefined;
        });

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        // Vary header should remain unchanged since Accept-Encoding is already present
        expect(setHeaderSpy).not.toHaveBeenCalledWith('vary', expect.anything());
      });

      it('should not match Accept-Encoding as substring in other headers', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');
        getHeaderSpy.mockImplementation((name) => {
          if (name === 'content-type') return 'text/plain';
          if (name === 'vary') return 'X-Accept-Encoding, Origin';
          return undefined;
        });

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        // Should add Accept-Encoding since X-Accept-Encoding is different
        expect(setHeaderSpy).toHaveBeenCalledWith(
          'vary',
          'X-Accept-Encoding, Origin, Accept-Encoding'
        );
      });

      it('should preserve Vary: * without modification', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');
        getHeaderSpy.mockImplementation((name) => {
          if (name === 'content-type') return 'text/plain';
          if (name === 'vary') return '*';
          return undefined;
        });

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        // Vary: * should remain unchanged (wildcard means all headers vary)
        expect(setHeaderSpy).not.toHaveBeenCalledWith('vary', expect.anything());
      });

      it('should create deflate compression stream', () => {
        const handler = new CompressionHandler();
        setupMock('deflate', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'deflate');
      });

      it('should create brotli compression stream when enabled', () => {
        const handler = new CompressionHandler({ brotli: true });
        setupMock('br', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'br');
      });

      it('should return null when body below threshold', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          SMALL_DATA
        );

        expect(stream).toBeNull();
      });

      it('should return null for non-compressible content-type', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'image/png');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeNull();
      });

      it('should return null when no accept-encoding', () => {
        const handler = new CompressionHandler();
        setupMock(undefined, 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeNull();
      });

      it('should prefer brotli over gzip when both accepted', () => {
        const handler = new CompressionHandler({ brotli: true });
        setupMock('gzip, deflate, br', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'br');
      });

      it('should handle quality values in accept-encoding', () => {
        const handler = new CompressionHandler();
        setupMock('gzip;q=0.8, deflate;q=1.0', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(stream).toBeInstanceOf(Transform);
        // Should prefer deflate (higher quality)
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'deflate');
      });

      it('should create stream without body check when body not provided', () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        // No body provided - should create stream without size check
        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse
        );

        expect(stream).toBeInstanceOf(Transform);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
      });

      describe('Streaming without body - content-type checks', () => {
        it('should reject image/jpeg without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'image/jpeg');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
        });

        it('should reject image/png without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'image/png');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
        });

        it('should reject video/mp4 without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'video/mp4');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
        });

        it('should reject application/zip without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'application/zip');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
        });

        it('should accept text/plain without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'text/plain');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
        });

        it('should accept application/json without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'application/json');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
        });

        it('should accept text/html without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'text/html');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
        });

        it('should reject already compressed content without body', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'text/plain', 'gzip');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
        });

        it('should accept when content-encoding is identity', () => {
          const handler = new CompressionHandler();
          setupMock('gzip', 'text/plain', 'identity');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
        });

        it('should respect custom filter without body', () => {
          const filter = jest.fn().mockReturnValue(false);
          const handler = new CompressionHandler({ filter });
          setupMock('gzip', 'text/plain');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeNull();
          expect(filter).toHaveBeenCalledWith(mockReq, mockRes);
        });

        it('should allow compression when filter returns true', () => {
          const filter = jest.fn().mockReturnValue(true);
          const handler = new CompressionHandler({ filter });
          setupMock('gzip', 'text/plain');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
          expect(filter).toHaveBeenCalledWith(mockReq, mockRes);
        });

        it('should allow compression when no content-type set', () => {
          const handler = new CompressionHandler();
          setupMock('gzip');

          const stream = handler.createCompressionStream(
            mockReq as UwsRequest,
            mockRes as UwsResponse
          );

          expect(stream).toBeInstanceOf(Transform);
        });
      });
    });

    describe('compressBuffer', () => {
      it('should compress buffer using gzip', async () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        const compressed = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(compressed).not.toBe(LARGE_DATA);
        expect(compressed.length).toBeLessThan(LARGE_DATA.length);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
        verifyDecompression(compressed, LARGE_DATA, 'gzip');
      });

      it('should compress buffer using deflate', async () => {
        const handler = new CompressionHandler();
        setupMock('deflate', 'text/plain');

        const compressed = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(compressed).not.toBe(LARGE_DATA);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'deflate');
        verifyDecompression(compressed, LARGE_DATA, 'deflate');
      });

      it('should compress buffer using brotli when enabled', async () => {
        const handler = new CompressionHandler({ brotli: true });
        setupMock('br', 'text/plain');

        const compressed = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          LARGE_DATA
        );

        expect(compressed).not.toBe(LARGE_DATA);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'br');
        verifyDecompression(compressed, LARGE_DATA, 'brotli');
      });

      it('should return original buffer when compression not needed', async () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        const result = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          SMALL_DATA
        );

        expect(result).toBe(SMALL_DATA);
        expect(setHeaderSpy).not.toHaveBeenCalled();
      });

      it.each([
        'text/plain',
        'text/html',
        'text/css',
        'application/json',
        'application/xml',
        'application/javascript',
        'image/svg+xml',
      ])('should compress %s content type', async (contentType) => {
        const handler = new CompressionHandler();
        const data = Buffer.from('x'.repeat(2000));
        setupMock('gzip', contentType);

        const compressed = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          data
        );

        expect(compressed).not.toBe(data);
        expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
      });

      it('should use custom compression level', async () => {
        const handlerLow = new CompressionHandler({ level: 1 });
        const handlerHigh = new CompressionHandler({ level: 9 });
        const data = Buffer.from('x'.repeat(10000));

        setupMock('gzip', 'text/plain');

        const resultLow = await handlerLow.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          data
        );

        setHeaderSpy.mockClear();
        const resultHigh = await handlerHigh.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          data
        );

        // Higher compression level should generally produce smaller or equal output
        // Both should compress the data significantly
        expect(resultHigh.length).toBeLessThanOrEqual(resultLow.length);
        expect(resultLow.length).toBeLessThan(data.length);
        expect(resultHigh.length).toBeLessThan(data.length);
      });

      it('should handle very large buffer', async () => {
        const handler = new CompressionHandler();
        const largeData = Buffer.from('x'.repeat(1024 * 1024));
        setupMock('gzip', 'text/plain');

        const compressed = await handler.compressBuffer(
          mockReq as UwsRequest,
          mockRes as UwsResponse,
          largeData
        );

        expect(compressed).not.toBe(largeData);
        expect(compressed.length).toBeLessThan(largeData.length);
      });
    });

    describe('Streaming Integration', () => {
      it('should work with streaming data', async () => {
        const handler = new CompressionHandler();
        setupMock('gzip', 'text/plain');

        const stream = handler.createCompressionStream(
          mockReq as UwsRequest,
          mockRes as UwsResponse
        );

        expect(stream).toBeInstanceOf(Transform);

        // Simulate streaming data through
        const chunks: Buffer[] = [];
        stream!.on('data', (chunk) => chunks.push(chunk));

        const dataPromise = new Promise<Buffer>((resolve) => {
          stream!.on('end', () => resolve(Buffer.concat(chunks)));
        });

        const errorPromise = new Promise<never>((_, reject) => {
          stream!.on('error', reject);
        });

        // Write data in chunks
        stream!.write(Buffer.from('Hello '));
        stream!.write(Buffer.from('World '));
        stream!.write(Buffer.from('x'.repeat(2000)));
        stream!.end();

        const compressed = await Promise.race([dataPromise, errorPromise]);
        expect(compressed.length).toBeGreaterThan(0);

        // Verify decompression
        const decompressed = zlib.gunzipSync(compressed);
        expect(decompressed.toString()).toBe('Hello World ' + 'x'.repeat(2000));
      });
    });
  });

  describe('Configuration', () => {
    it('should use default threshold (1KB)', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        Buffer.from('x'.repeat(500))
      );

      expect(result.length).toBe(500); // Not compressed

      setHeaderSpy.mockClear();
      const resultAbove = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        Buffer.from('x'.repeat(1024))
      );

      expect(resultAbove.length).toBeLessThan(1024); // Compressed
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
    });

    it('should use custom threshold', async () => {
      const handler = new CompressionHandler({ threshold: 100 });
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        Buffer.from('x'.repeat(500))
      );

      expect(result.length).toBeLessThan(500); // Compressed
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
    });

    it('should handle empty options', async () => {
      const handler = new CompressionHandler({});
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      expect(result).not.toBe(LARGE_DATA);
    });

    it('should validate compression level range', () => {
      expect(() => new CompressionHandler({ level: -1 })).toThrow(RangeError);
      expect(() => new CompressionHandler({ level: 10 })).toThrow(RangeError);
      expect(() => new CompressionHandler({ level: 0 })).not.toThrow();
      expect(() => new CompressionHandler({ level: 9 })).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty body', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        Buffer.from('')
      );

      expect(result.length).toBe(0);
    });

    it.each([
      ['case-insensitive', 'GZIP'],
      ['whitespace', '  gzip  ,  deflate  '],
    ])('should handle %s encoding names', async (_name, acceptEncoding) => {
      const handler = new CompressionHandler();
      setupMock(acceptEncoding, 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      expect(result).not.toBe(LARGE_DATA);
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
    });

    it('should handle array content-type header', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', undefined);
      getHeaderSpy.mockImplementation((name) => {
        if (name === 'content-type') return ['text/plain', 'charset=utf-8'] as any;
        return undefined;
      });

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      expect(result).not.toBe(LARGE_DATA);
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
    });

    it('should respect custom filter function', async () => {
      const filter = jest.fn().mockReturnValue(false);
      const handler = new CompressionHandler({ filter });
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      expect(filter).toHaveBeenCalledWith(mockReq, mockRes);
      expect(result).toBe(LARGE_DATA);
      expect(setHeaderSpy).not.toHaveBeenCalled();
    });

    it('should not compress when already compressed', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', 'text/plain', 'gzip');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      expect(result).toBe(LARGE_DATA);
    });

    it('should remove Content-Length header when compressing buffer', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', 'text/plain');
      const removeHeaderSpy = jest.spyOn(mockRes, 'removeHeader');

      await handler.compressBuffer(mockReq as UwsRequest, mockRes as UwsResponse, LARGE_DATA);

      expect(removeHeaderSpy).toHaveBeenCalledWith('content-length');
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'gzip');
    });

    it('should update Content-Length to compressed size', async () => {
      const handler = new CompressionHandler();
      setupMock('gzip', 'text/plain');

      const result = await handler.compressBuffer(
        mockReq as UwsRequest,
        mockRes as UwsResponse,
        LARGE_DATA
      );

      // Verify Content-Length was set to compressed size
      expect(setHeaderSpy).toHaveBeenCalledWith('content-length', result.length.toString());
      expect(result.length).toBeLessThan(LARGE_DATA.length);
    });

    it('should remove Content-Length for brotli compression', async () => {
      const handler = new CompressionHandler({ brotli: true });
      setupMock('br', 'text/plain');
      const removeHeaderSpy = jest.spyOn(mockRes, 'removeHeader');

      await handler.compressBuffer(mockReq as UwsRequest, mockRes as UwsResponse, LARGE_DATA);

      expect(removeHeaderSpy).toHaveBeenCalledWith('content-length');
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'br');
    });

    it('should remove Content-Length for deflate compression', async () => {
      const handler = new CompressionHandler();
      setupMock('deflate', 'text/plain');
      const removeHeaderSpy = jest.spyOn(mockRes, 'removeHeader');

      await handler.compressBuffer(mockReq as UwsRequest, mockRes as UwsResponse, LARGE_DATA);

      expect(removeHeaderSpy).toHaveBeenCalledWith('content-length');
      expect(setHeaderSpy).toHaveBeenCalledWith('content-encoding', 'deflate');
    });
  });
});
