# Response

The `UwsResponse` component provides an Express-compatible HTTP response object with enhanced performance and streaming capabilities through uWebSockets.js.

* See [ExpressJS](https://expressjs.com/en/4x/api.html#res) for more information on Express compatibility methods and properties.
* See [Node.js ServerResponse](https://nodejs.org/api/http.html#class-httpserverresponse) for more information on Node.js HTTP response properties.

## Table of Contents

- [Properties](#properties)
- [Status Methods](#status-methods)
- [Header Methods](#header-methods)
- [Content Type Methods](#content-type-methods)
- [Cookie Methods](#cookie-methods)
- [Response Methods](#response-methods)
- [Streaming Methods](#streaming-methods)
- [Redirect Methods](#redirect-methods)
- [File Methods](#file-methods)
- [Examples](#examples)

## Properties

### raw

```typescript
readonly raw: uWS.HttpResponse
```

The underlying raw uWebSockets.js HTTP response instance.

**Warning:** Direct manipulation of the raw response is unsafe and may cause unexpected behavior.

### statusCodeValue

```typescript
readonly statusCodeValue: number
```

Current HTTP status code.

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.status(404);
  console.log(res.statusCodeValue); // 404
}
```

### headersSent

```typescript
readonly headersSent: boolean
```

True if headers have been sent to the client.

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  console.log(res.headersSent); // false
  res.send('Hello');
  console.log(res.headersSent); // true
}
```

### isFinished

```typescript
readonly isFinished: boolean
```

True if the response has been completed.

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  if (!res.isFinished) {
    res.send('Data');
  }
}
```

### isAborted

```typescript
readonly isAborted: boolean
```

True if the connection was aborted by the client.

**Example:**

```typescript
@Get()
async handler(@Res() res: UwsResponse) {
  const data = await this.fetchLargeData();
  
  if (res.isAborted) {
    console.log('Client disconnected');
    return;
  }
  
  res.send(data);
}
```

## Status Methods

### status()

```typescript
status(code: number, message?: string): this
```

Set the HTTP status code and optional custom message.

**Parameters:**
- `code` - HTTP status code
- `message` - Optional custom status message

**Returns:** this (chainable)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // Standard status
  res.status(200).send('OK');
  
  // Custom message
  res.status(200, 'Custom OK').send();
  
  // Common status codes
  res.status(201).json({ created: true });
  res.status(204).send();
  res.status(400).json({ error: 'Bad Request' });
  res.status(404).send('Not Found');
  res.status(500).json({ error: 'Internal Server Error' });
}
```

## Header Methods

### setHeader()

```typescript
setHeader(name: string, value: string | string[], overwrite?: boolean): this
```

Set a response header.

**Parameters:**
- `name` - Header name
- `value` - Header value (string or array)
- `overwrite` - Whether to overwrite existing values (default: true)

**Returns:** this (chainable)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // Single value
  res.setHeader('Content-Type', 'application/json');
  
  // Multiple values (accumulate)
  res.setHeader('Set-Cookie', 'session=abc', false);
  res.setHeader('Set-Cookie', 'user=123', false);
  
  // Array value
  res.setHeader('Set-Cookie', ['session=abc', 'user=123']);
}
```

### header()

```typescript
header(name: string, value: string | string[], overwrite?: boolean): this
```

Alias for `setHeader()`.

### getHeader()

```typescript
getHeader(name: string): string | string[] | undefined
```

Get a response header value (case-insensitive).

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.setHeader('Content-Type', 'application/json');
  console.log(res.getHeader('content-type')); // 'application/json'
}
```

### hasHeader()

```typescript
hasHeader(name: string): boolean
```

Check if a header exists (case-insensitive).

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  if (!res.hasHeader('Content-Type')) {
    res.setHeader('Content-Type', 'text/plain');
  }
}
```

### removeHeader()

```typescript
removeHeader(name: string): this
```

Remove a response header.

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.setHeader('X-Custom', 'value');
  res.removeHeader('X-Custom');
}
```

### append()

```typescript
append(name: string, value: string): this
```

Append a value to a header (creates header if it doesn't exist).

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.append('Set-Cookie', 'session=abc');
  res.append('Set-Cookie', 'user=123');
  // Results in: ['session=abc', 'user=123']
}
```

## Content Type Methods

### type()

```typescript
type(type: string): this
```

Set the Content-Type header. Accepts MIME types or file extensions.

**Parameters:**
- `type` - MIME type or file extension

**Returns:** this (chainable)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // MIME type
  res.type('application/json').send('{}');
  
  // File extension
  res.type('json').send('{}');
  res.type('html').send('<h1>Hello</h1>');
  res.type('txt').send('Plain text');
  res.type('png').send(imageBuffer);
  
  // With leading dot
  res.type('.pdf').send(pdfBuffer);
}
```

### contentType()

```typescript
contentType(type: string): this
```

Alias for `type()`.

## Cookie Methods

### setCookie()

```typescript
setCookie(name: string, value: string | null, options?: CookieOptions): this
```

Set a cookie. Pass `null` as value to delete the cookie.

**Parameters:**
- `name` - Cookie name
- `value` - Cookie value (null to delete)
- `options` - Cookie options

**Returns:** this (chainable)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // Simple cookie
  res.setCookie('session', 'abc123');
  
  // With options
  res.setCookie('session', 'abc123', {
    path: '/api',
    httpOnly: true,
    secure: true,
    maxAge: 3600,
    sameSite: 'strict',
  });
  
  // Signed cookie
  res.setCookie('auth', 'token123', {
    secret: 'my-secret',
    httpOnly: true,
  });
  
  // Delete cookie
  res.setCookie('session', null);
}
```

### cookie()

```typescript
cookie(name: string, value: string | object, options?: CookieOptions): this
```

Set a cookie with Express-compatible API. Automatically serializes objects to JSON.

**Parameters:**
- `name` - Cookie name
- `value` - Cookie value (string or object)
- `options` - Cookie options

**Returns:** this (chainable)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // String value
  res.cookie('name', 'value');
  
  // Object value (auto-serialized)
  res.cookie('cart', { items: [1, 2, 3] });
  
  // With maxAge (milliseconds)
  res.cookie('session', 'abc', { maxAge: 900000 }); // 15 minutes
  
  // Signed cookie
  res.cookie('user', 'john', {
    signed: true,
    secret: 'my-secret',
  });
  
  // Secure cookie
  res.cookie('auth', 'token', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });
}
```

### clearCookie()

```typescript
clearCookie(name: string, options?: CookieOptions): this
```

Clear a cookie by setting it to expire immediately.

**Parameters:**
- `name` - Cookie name
- `options` - Cookie options (must match original cookie's path/domain)

**Returns:** this (chainable)

**Example:**

```typescript
@Get('logout')
handler(@Res() res: UwsResponse) {
  res.clearCookie('session');
  res.clearCookie('auth', { path: '/api' });
  res.json({ message: 'Logged out' });
}
```

### CookieOptions

```typescript
interface CookieOptions {
  domain?: string;
  path?: string;
  maxAge?: number;      // In seconds (setCookie) or milliseconds (cookie)
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: boolean | 'none' | 'lax' | 'strict';
  secret?: string;      // For signing cookies
  signed?: boolean;     // Use with cookie() method
}
```

## Response Methods

### send()

```typescript
send(body?: string | Buffer | object): void
```

Send the HTTP response. Automatically sets Content-Type based on body type.

**Parameters:**
- `body` - Response body (string, Buffer, or object)

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  // String
  res.send('Hello World');
  
  // Object (auto-converts to JSON)
  res.send({ message: 'Hello' });
  
  // Buffer
  res.send(Buffer.from('Binary data'));
  
  // Empty response
  res.status(204).send();
}
```

### json()

```typescript
json(body: any): void
```

Send a JSON response. Sets Content-Type to application/json.

**Parameters:**
- `body` - Object to serialize as JSON

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.json({
    status: 'success',
    data: { id: 1, name: 'John' },
  });
}
```

### end()

```typescript
end(chunk?: string | Buffer, encoding?: BufferEncoding, callback?: () => void): void
```

End the response with optional final chunk.

**Parameters:**
- `chunk` - Optional final data chunk
- `encoding` - Optional encoding for string chunks
- `callback` - Optional callback when response is finished

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.writeChunk('Part 1\n');
  res.writeChunk('Part 2\n');
  res.end('Final part', () => {
    console.log('Response sent');
  });
}
```

## Streaming Methods

### writeChunk()

```typescript
writeChunk(chunk: string | Buffer | ArrayBuffer, encoding?: BufferEncoding): boolean
```

Write a chunk of data with automatic batching and backpressure handling.

**Parameters:**
- `chunk` - Data chunk to write
- `encoding` - Optional encoding for string chunks

**Returns:** true if chunk was sent, false if response is finished/aborted

**Example:**

```typescript
@Get('stream')
async handler(@Res() res: UwsResponse) {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  // Write chunks (automatically batched)
  res.writeChunk('Chunk 1\n');
  res.writeChunk('Chunk 2\n');
  res.writeChunk('Chunk 3\n');
  
  // Finish response
  res.send();
}
```

### stream()

```typescript
stream(readable: Readable, totalSize?: number): Promise<void>
```

Stream a Node.js Readable stream as the response body.

**Parameters:**
- `readable` - Readable stream to pipe
- `totalSize` - Optional total size for Content-Length header

**Returns:** Promise that resolves when streaming completes

**Example:**

```typescript
@Get('file')
async handler(@Res() res: UwsResponse) {
  const fileStream = fs.createReadStream('large-file.txt');
  const stats = fs.statSync('large-file.txt');
  
  res.setHeader('Content-Type', 'text/plain');
  await res.stream(fileStream, stats.size);
}

@Get('video')
async handler(@Res() res: UwsResponse) {
  const videoStream = fs.createReadStream('video.mp4');
  
  res.setHeader('Content-Type', 'video/mp4');
  await res.stream(videoStream);
}
```

### pipeFrom()

```typescript
pipeFrom(readable: Readable): this
```

Pipe a Readable stream to the response (alternative to stream()).

**Parameters:**
- `readable` - Readable stream to pipe

**Returns:** this (chainable)

**Example:**

```typescript
@Get('download')
handler(@Res() res: UwsResponse) {
  const fileStream = fs.createReadStream('document.pdf');
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');
  res.pipeFrom(fileStream);
}
```

## Redirect Methods

### redirect()

```typescript
redirect(url: string, statusCode?: number): void
```

Redirect to the specified URL with optional status code.

**Parameters:**
- `url` - Redirect URL
- `statusCode` - HTTP status code (default: 302)

**Example:**

```typescript
@Get('old-path')
handler(@Res() res: UwsResponse) {
  // Temporary redirect (302)
  res.redirect('/new-path');
  
  // Permanent redirect (301)
  res.redirect('/new-path', 301);
  
  // See Other (303)
  res.redirect('/success', 303);
  
  // Temporary Redirect (307)
  res.redirect('/login', 307);
  
  // External redirect
  res.redirect('https://example.com');
}
```

### location()

```typescript
location(url: string): this
```

Set the Location header without sending a redirect response.

**Parameters:**
- `url` - Location URL

**Returns:** this (chainable)

**Example:**

```typescript
@Post('resource')
handler(@Res() res: UwsResponse) {
  const newResource = this.create();
  
  res.location(`/resources/${newResource.id}`)
     .status(201)
     .json(newResource);
}
```

## File Methods

### attachment()

```typescript
attachment(filename?: string): this
```

Set Content-Disposition header to attachment with optional filename.

**Parameters:**
- `filename` - Optional filename

**Returns:** this (chainable)

**Example:**

```typescript
@Get('download')
handler(@Res() res: UwsResponse) {
  // Without filename
  res.attachment();
  
  // With filename
  res.attachment('report.pdf');
  res.send(pdfBuffer);
  
  // Auto-sets Content-Type based on extension
  res.attachment('document.pdf'); // Sets application/pdf
  res.attachment('image.png');    // Sets image/png
}
```

## Advanced Methods

### atomic()

```typescript
atomic(callback: () => void): void
```

Execute multiple response operations atomically (corked). Improves performance when setting multiple headers or writing multiple chunks.

**Parameters:**
- `callback` - Function to execute atomically

**Example:**

```typescript
@Get()
handler(@Res() res: UwsResponse) {
  res.atomic(() => {
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Custom-1', 'value1');
    res.setHeader('X-Custom-2', 'value2');
    res.send({ data: 'response' });
  });
}
```

## Examples

### JSON API Response

```typescript
@Get('users/:id')
async getUser(@Param('id') id: string, @Res() res: UwsResponse) {
  const user = await this.userService.findById(id);
  
  if (!user) {
    return res.status(404).json({
      error: 'User not found',
      statusCode: 404,
    });
  }
  
  return res.json({
    data: user,
    meta: { timestamp: Date.now() },
  });
}
```

### File Download

```typescript
import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import { UwsResponse } from 'uwestjs';
import * as fs from 'fs';
import * as path from 'path';

@Get('download/:filename')
async downloadFile(@Param('filename') filename: string, @Res() res: UwsResponse) {
  // SECURITY: Prevent path traversal attacks
  const safeFilename = path.basename(filename);
  
  // Validate filename doesn't contain path separators
  if (safeFilename !== filename || safeFilename.includes('..')) {
    return res.status(400).send('Invalid filename');
  }
  
  const filePath = path.join(__dirname, 'files', safeFilename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  
  const stats = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath);
  
  res.setHeader('Content-Length', stats.size.toString());
  res.attachment(safeFilename);
  
  await res.stream(fileStream, stats.size);
}
```

Note: For simple file downloads, consider using `app.useStaticAssets()` which provides built-in security (path traversal protection, null byte protection, dotfile control). Only implement custom download endpoints when you need special logic like authentication or logging.

### Streaming Response

```typescript
@Get('logs')
async streamLogs(@Res() res: UwsResponse) {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  const logs = await this.logService.streamLogs();
  
  for await (const log of logs) {
    if (res.isAborted) break;
    res.writeChunk(`${log}\n`);
  }
  
  res.send();
}
```

### Conditional Response

```typescript
@Get('resource')
async getResource(@Req() req: UwsRequest, @Res() res: UwsResponse) {
  const resource = await this.resourceService.get();
  const etag = this.generateETag(resource);
  
  const ifNoneMatch = req.get('If-None-Match');
  
  if (ifNoneMatch === etag) {
    return res.status(304).send();
  }
  
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(resource);
}
```

### Cookie-based Authentication

```typescript
@Post('login')
async login(@Body() credentials: LoginDto, @Res() res: UwsResponse) {
  const user = await this.authService.validateUser(credentials);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = this.authService.generateToken(user);
  
  res.cookie('auth', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 86400000, // 24 hours
    signed: true,
    secret: process.env.COOKIE_SECRET,
  });
  
  res.json({ message: 'Logged in successfully' });
}

@Post('logout')
logout(@Res() res: UwsResponse) {
  res.clearCookie('auth');
  res.json({ message: 'Logged out successfully' });
}
```

### Content Negotiation

```typescript
@Get('data')
async getData(@Req() req: UwsRequest, @Res() res: UwsResponse) {
  const data = await this.dataService.getData();
  
  const accept = req.accepts('json', 'xml', 'csv');
  
  switch (accept) {
    case 'json':
      return res.json(data);
      
    case 'xml':
      const xml = this.convertToXML(data);
      return res.type('xml').send(xml);
      
    case 'csv':
      const csv = this.convertToCSV(data);
      return res.type('csv')
                .attachment('data.csv')
                .send(csv);
      
    default:
      return res.status(406).json({
        error: 'Not Acceptable',
        supported: ['application/json', 'application/xml', 'text/csv'],
      });
  }
}
```

### Range Request (Video Streaming)

```typescript
@Get('video/:id')
async streamVideo(
  @Param('id') id: string,
  @Req() req: UwsRequest,
  @Res() res: UwsResponse,
) {
  const videoPath = await this.videoService.getPath(id);
  const stats = fs.statSync(videoPath);
  const fileSize = stats.size;
  
  const range = req.range(fileSize);
  
  if (range === -1) {
    return res.status(400).send('Malformed Range header');
  }
  
  if (range === -2) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).send('Range Not Satisfiable');
  }
  
  if (Array.isArray(range) && range.length > 0) {
    const { start, end } = range[0];
    const chunkSize = end - start + 1;
    
    const fileStream = fs.createReadStream(videoPath, { start, end });
    
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize.toString());
    res.setHeader('Content-Type', 'video/mp4');
    
    await res.stream(fileStream, chunkSize);
  } else {
    // Full file
    const fileStream = fs.createReadStream(videoPath);
    
    res.setHeader('Content-Length', fileSize.toString());
    res.setHeader('Content-Type', 'video/mp4');
    
    await res.stream(fileStream, fileSize);
  }
}
```

### Server-Sent Events (SSE)

```typescript
@Get('events')
async streamEvents(@Res() res: UwsResponse) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendEvent = (data: any) => {
    if (res.isAborted) return false;
    res.writeChunk(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  };
  
  // Send initial event
  sendEvent({ type: 'connected', timestamp: Date.now() });
  
  // Subscribe to events
  const subscription = this.eventService.subscribe((event) => {
    if (!sendEvent(event)) {
      subscription.unsubscribe();
    }
  });
  
  // Cleanup on abort
  res._onAbort(() => {
    subscription.unsubscribe();
  });
}
```

## Performance Tips

1. **Use atomic() for multiple operations** - Reduces syscalls
2. **Use writeChunk() for streaming** - Automatic batching and backpressure handling
3. **Set Content-Length when known** - Enables better client-side handling
4. **Use ETags for caching** - Reduces bandwidth and server load
5. **Enable compression** - Enable via `compress` option in `UwsPlatformAdapter`
6. **Stream large responses** - Prevents memory issues
7. **Check isAborted before expensive operations** - Avoid wasted work

## See Also

- [Request](./Request.md) - HTTP Request object documentation
- [Server](./Server.md) - Server configuration and setup
- [Static Files](./Static-Files.md) - Static file serving documentation
