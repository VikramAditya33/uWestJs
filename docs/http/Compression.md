# HTTP Compression

Automatic request and response compression support for reducing bandwidth usage.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Supported Algorithms](#supported-algorithms)
- [Response Compression](#response-compression)
- [Request Decompression](#request-decompression)
- [Examples](#examples)

---

## Overview

uWestJS provides built-in compression support for requests and responses:

- **Response Compression** - Automatically compress responses based on client capabilities
- **Request Decompression** - Automatically decompress incoming compressed requests
- **Multiple Algorithms** - Support for gzip, deflate, and brotli compression
- **Smart Compression** - Only compress compressible content types
- **Configurable Thresholds** - Control when compression is applied

---

## Configuration

### Basic Setup

Enable compression when creating the HTTP adapter:

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsPlatformAdapter } from 'uwestjs';

const app = await NestFactory.create(
  AppModule,
  new UwsPlatformAdapter({
    compress: {
      threshold: 1024, // Compress responses >= 1KB
      level: 6, // Balanced compression
      brotli: true, // Enable brotli
    },
  })
);
```

### Compression Options

```typescript
interface CompressionOptions {
  threshold?: number;
  level?: number;
  brotli?: boolean;
  filter?: (req: UwsRequest, res: UwsResponse) => boolean;
}
```

### threshold

```typescript
threshold?: number
```

Minimum response size (in bytes) to compress. Responses smaller than this won't be compressed.

**Default:** `1024` (1KB)

**Example:**

```typescript
new UwsPlatformAdapter({
  compress: {
    threshold: 2048, // Only compress responses >= 2KB
  },
})
```

### level

```typescript
level?: number
```

Compression level for gzip and deflate (0-9).

- `0` - No compression (fastest)
- `1` - Fastest compression
- `6` - Default compression (balanced)
- `9` - Best compression (slowest)

For Brotli, this is automatically mapped to quality 0-11 (level 9 → quality 11).

**Default:** `6`

**Example:**

```typescript
new UwsPlatformAdapter({
  compress: {
    level: 9, // Maximum compression
  },
})
```

### brotli

```typescript
brotli?: boolean
```

Enable brotli compression in addition to gzip/deflate.

**Default:** `false`

**Example:**

```typescript
new UwsPlatformAdapter({
  compress: {
    brotli: true, // Enable brotli
  },
})
```

### filter

```typescript
filter?: (req: UwsRequest, res: UwsResponse) => boolean
```

Custom function to determine if a response should be compressed. Return `false` to skip compression for specific responses.

**Example:**

```typescript
import { UwsRequest, UwsResponse } from 'uwestjs';

new UwsPlatformAdapter({
  compress: {
    filter: (req: UwsRequest, res: UwsResponse) => {
      // Don't compress responses for specific paths
      if (req.url.startsWith('/api/stream')) {
        return false;
      }
      return true;
    },
  },
})
```



---

## Supported Algorithms

### Algorithm Priority

When a client supports multiple algorithms, the server uses this priority:

1. **Brotli (br)** - Best compression ratio, modern browsers
2. **Gzip (gzip)** - Good compression, universal support
3. **Deflate (deflate)** - Basic compression, legacy support

### Client Support

The server automatically selects the best algorithm based on the `Accept-Encoding` header:

```http
Accept-Encoding: gzip, deflate, br
```

---

## Response Compression

### Automatic Compression

Responses are automatically compressed when:

1. Client supports compression (via `Accept-Encoding` header)
2. Response size exceeds threshold (default: 1KB)
3. Content type is compressible
4. Response hasn't been sent yet

**Example:**

```typescript
@Controller('api')
export class ApiController {
  @Get('data')
  getData() {
    // Large response will be automatically compressed
    return {
      data: Array(1000).fill({ id: 1, name: 'Item', description: 'Description' }),
    };
  }
}
```

### Compressible Content Types

By default, these content types are compressed:

- `text/*` (text/html, text/plain, text/css, text/javascript, etc.)
- `application/json`
- `application/javascript`
- `application/xml`
- `application/x-javascript`
- `image/svg+xml`

**Non-compressible types** (already compressed):
- `image/jpeg`, `image/png`, `image/gif`
- `video/*`
- `audio/*`
- `application/zip`, `application/gzip`

### Streaming Compression

For streaming responses, compression is applied on-the-fly:

```typescript
@Controller('api')
export class StreamController {
  @Get('stream')
  streamData(@Res() res: UwsResponse) {
    // Stream will be compressed automatically
    const stream = fs.createReadStream('large-file.json');
    res.stream(stream);
  }
}
```

### Vary Header

The server automatically adds the `Vary: Accept-Encoding` header to compressed responses for proper caching:

```http
HTTP/1.1 200 OK
Content-Encoding: gzip
Vary: Accept-Encoding
Content-Type: application/json
```

---

## Request Decompression

### Automatic Decompression

Incoming compressed requests are automatically decompressed based on the `Content-Encoding` header. This happens at the stream level before body parsing.

```typescript
@Controller('api')
export class UploadController {
  @Post('upload')
  async upload(@Body() data: any) {
    // Request body is automatically decompressed
    console.log(data);
    return { received: true };
  }
}
```

### Supported Encodings

- `gzip` - Gzip compressed requests
- `deflate` - Deflate compressed requests
- `br` - Brotli compressed requests

### Size Limits

Decompressed request size is limited by the body parser's `maxBodySize` option (default: 1MB). This protects against decompression bombs:

```typescript
new UwsPlatformAdapter({
  maxBodySize: 5 * 1024 * 1024, // 5MB limit
})
```

### Manual Decompression

If you need to decompress buffers outside the automatic pipeline (e.g., in custom middleware), `CompressionHandler.decompressRequest()` is available. It also accepts `inflate` and `maxInflatedBodySize` options for fine-grained control:

```typescript
import { CompressionHandler } from 'uwestjs';

const handler = new CompressionHandler({
  inflate: true,
  maxInflatedBodySize: 5 * 1024 * 1024, // 5MB
});

const decompressed = await handler.decompressRequest(req, compressedBuffer);
```

> **Note:** These options only affect manual `decompressRequest()` calls. Automatic request decompression uses the body parser's `maxBodySize` and cannot be disabled via `inflate`.

**Example client request:**

```bash
# Compress and send data
echo '{"large":"data"}' | gzip | curl -X POST \
  -H "Content-Encoding: gzip" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  http://localhost:3000/api/upload
```

---

## Examples

### Basic Configuration

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsPlatformAdapter } from 'uwestjs';

const app = await NestFactory.create(
  AppModule,
  new UwsPlatformAdapter({
    compress: {
      threshold: 1024, // 1KB
      level: 6, // Default compression
    },
  })
);

await app.listen(3000);
```

### High Compression

For maximum compression (slower, but smaller responses):

```typescript
new UwsPlatformAdapter({
  compress: {
    level: 9, // Maximum compression
    brotli: true, // Enable brotli
  },
})
```

### Fast Compression

For faster compression (larger responses, but faster):

```typescript
new UwsPlatformAdapter({
  compress: {
    level: 1, // Fastest compression
    brotli: true, // Enable brotli
  },
})
```

### Selective Compression

Compress only specific routes:

```typescript
import { UwsRequest, UwsResponse } from 'uwestjs';

new UwsPlatformAdapter({
  compress: {
    filter: (req: UwsRequest, res: UwsResponse) => {
      // Only compress API responses
      if (req.url.startsWith('/api/')) {
        return true;
      }
      // Don't compress static files (already optimized)
      if (req.url.startsWith('/static/')) {
        return false;
      }
      return true;
    },
  },
})
```

### Large Threshold

Only compress very large responses:

```typescript
new UwsPlatformAdapter({
  compress: {
    threshold: 10240, // Only compress responses >= 10KB
  },
})
```

### Disable Brotli

Use only gzip and deflate:

```typescript
new UwsPlatformAdapter({
  compress: {
    brotli: false, // Disable brotli (default)
  },
})
```

### API Response Compression

```typescript
@Controller('api')
export class DataController {
  @Get('large-dataset')
  getLargeDataset() {
    // This response will be automatically compressed
    return {
      data: Array(10000).fill({
        id: 1,
        name: 'Item',
        description: 'Long description text',
        metadata: {
          created: new Date(),
          updated: new Date(),
        },
      }),
    };
  }
  
  @Get('small-response')
  getSmallResponse() {
    // This response won't be compressed (below threshold)
    return { status: 'ok' };
  }
}
```

### Compressed Upload

```typescript
@Controller('api')
export class UploadController {
  @Post('upload-compressed')
  async uploadCompressed(@Body() data: any) {
    // Client sends compressed data:
    // curl -X POST -H "Content-Encoding: gzip" \
    //   -H "Content-Type: application/json" \
    //   --data-binary @data.json.gz \
    //   http://localhost:3000/api/upload-compressed
    
    // Request body decompression is available via CompressionHandler.decompressRequest()
    // but is not automatically wired into the request pipeline.
    console.log('Received data:', data);
    return { received: true, size: JSON.stringify(data).length };
  }
}
```

### Streaming with Compression

```typescript
@Controller('api')
export class StreamController {
  @Get('stream-large-file')
  streamLargeFile(@Res() res: UwsResponse) {
    res.setHeader('Content-Type', 'application/json');
    
    // Stream will be compressed automatically
    const stream = fs.createReadStream('large-data.json');
    res.stream(stream);
  }
}
```

---

## Performance Considerations

### Compression Level Trade-offs

- **Level 1-3** - Fast compression, larger files, good for real-time data
- **Level 4-6** - Balanced compression (recommended for most use cases)
- **Level 7-9** - Slow compression, smaller files, good for static content

### When to Disable Compression

Disable compression for:

- Already compressed content (images, videos, archives)
- Very small responses (< 1KB)
- Real-time streaming where latency matters
- CPU-constrained environments

### Brotli vs Gzip

**Brotli:**
- Better compression ratio (10-20% smaller)
- Slower compression
- Modern browser support
- Best for static content

**Gzip:**
- Faster compression
- Universal support
- Good for dynamic content
- Better for real-time responses

---

## See Also

- [Server](./Server.md)
- [Request](./Request.md)
- [Response](./Response.md)
- [Body Parsing](./Body-Parsing.md)
