# WebSocket Adapter

The UwsAdapter integrates uWebSockets.js with NestJS for high-performance WebSocket communication.

## Table of Contents

- [Overview](#overview)
- [Constructor](#constructor)
- [Configuration Options](#configuration-options)
- [Methods](#methods)
- [Manual Gateway Registration](#manual-gateway-registration)
- [HTTP + WebSocket Integration](#http--websocket-integration)
- [Examples](#examples)

---

## Overview

The UwsAdapter provides a high-performance WebSocket implementation using uWebSockets.js. It supports:

- Manual gateway registration for better control
- Multiple gateway support
- Dependency injection for middleware
- Room-based broadcasting
- SSL/TLS support
- HTTP + WebSocket integration (v2.0.0+)

## Constructor

```typescript
constructor(app: INestApplicationContext, options?: UwsAdapterOptions)
```

Creates a new UwsAdapter instance.

**Parameters:**
- `app` - NestJS application context
- `options` - Optional configuration options

**Example:**

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsAdapter } from 'uwestjs';

const app = await NestFactory.create(AppModule);
const adapter = new UwsAdapter(app, {
  port: 8099,
  maxPayloadLength: 16384,
  idleTimeout: 60,
});
app.useWebSocketAdapter(adapter);
```

---

## Configuration Options

### UwsAdapterOptions

```typescript
interface UwsAdapterOptions {
  port?: number;
  maxPayloadLength?: number;
  idleTimeout?: number;
  compression?: uWS.CompressOptions;
  path?: string;
  maxBackpressure?: number;
  closeOnBackpressureLimit?: boolean;
  sendPingsAutomatically?: boolean;
  maxLifetime?: number;
  cors?: CorsOptions;
  moduleRef?: ModuleRef;
  uwsApp?: uWS.TemplatedApp;
  cert_file_name?: string;
  key_file_name?: string;
  passphrase?: string;
  dh_params_file_name?: string;
  ssl_prefer_low_memory_usage?: boolean;
}
```

### port

```typescript
port?: number
```

WebSocket server port.

**Default:** `8099`

**Example:**

```typescript
new UwsAdapter(app, { port: 3001 });
```

### maxPayloadLength

```typescript
maxPayloadLength?: number
```

Maximum payload length in bytes. Messages larger than this will be rejected.

**Default:** `16384` (16KB)

**Example:**

```typescript
// Allow 1MB messages
new UwsAdapter(app, { maxPayloadLength: 1024 * 1024 });

// For large file transfers
new UwsAdapter(app, { maxPayloadLength: 10 * 1024 * 1024 }); // 10MB
```

### idleTimeout

```typescript
idleTimeout?: number
```

Idle timeout in seconds. Connections that don't send any data within this time will be automatically closed.

**Default:** `60` seconds

**Example:**

```typescript
// 5 minute timeout
new UwsAdapter(app, { idleTimeout: 300 });

// Disable timeout (not recommended for production)
new UwsAdapter(app, { idleTimeout: 0 });
```

### compression

```typescript
compression?: uWS.CompressOptions
```

Compression mode for WebSocket messages.

**Default:** `SHARED_COMPRESSOR`

**Options:**
- `DISABLED` - No compression
- `SHARED_COMPRESSOR` - Shared compressor (recommended)
- `DEDICATED_COMPRESSOR_3KB` to `DEDICATED_COMPRESSOR_256KB` - Various dedicated compressor sizes

**Example:**

```typescript
import { UwsAdapter, DISABLED, DEDICATED_COMPRESSOR_3KB } from 'uwestjs';

// Disable compression
new UwsAdapter(app, { compression: DISABLED });

// Use dedicated compressor (higher memory, better compression)
new UwsAdapter(app, { compression: DEDICATED_COMPRESSOR_3KB });
```

### path

```typescript
path?: string
```

WebSocket endpoint path.

**Default:** `'/*'`

**Example:**

```typescript
// Specific path
new UwsAdapter(app, { path: '/ws' });

// Multiple paths (use wildcard)
new UwsAdapter(app, { path: '/api/ws/*' });
```

### maxBackpressure

```typescript
maxBackpressure?: number
```

Maximum backpressure (buffered bytes) per WebSocket connection. When a client is slow to receive data, messages are buffered. If the buffer exceeds this limit, behavior depends on `closeOnBackpressureLimit`.

**Default:** `1048576` (1MB)

**Example:**

```typescript
// Allow 5MB of buffered data per connection
new UwsAdapter(app, { maxBackpressure: 5 * 1024 * 1024 });

// Strict limit for memory-constrained environments
new UwsAdapter(app, { maxBackpressure: 512 * 1024 }); // 512KB
```

### closeOnBackpressureLimit

```typescript
closeOnBackpressureLimit?: boolean
```

Close connection when backpressure limit is exceeded. When `true`, connections that exceed `maxBackpressure` are automatically closed. When `false`, messages continue to buffer (may cause memory issues with slow clients).

**Default:** `false`

**Example:**

```typescript
// Protect server from slow clients
new UwsAdapter(app, {
  maxBackpressure: 1024 * 1024,
  closeOnBackpressureLimit: true,
});

// Allow unlimited buffering (use with caution)
new UwsAdapter(app, { closeOnBackpressureLimit: false });
```

### sendPingsAutomatically

```typescript
sendPingsAutomatically?: boolean
```

Automatically send ping frames to keep connections alive. When enabled, the server automatically sends WebSocket ping frames to detect dead connections. Clients must respond with pong frames or the connection will be closed after `idleTimeout` seconds.

**Default:** `true`

**Example:**

```typescript
// Enable automatic pings (recommended)
new UwsAdapter(app, {
  sendPingsAutomatically: true,
  idleTimeout: 120, // Close if no pong received within 120s
});

// Disable if client handles pings manually
new UwsAdapter(app, { sendPingsAutomatically: false });
```

### maxLifetime

```typescript
maxLifetime?: number
```

Maximum connection lifetime in minutes. Maximum number of minutes a WebSocket connection may remain open before being automatically closed by the server. Set to `0` to disable this feature. This is useful for forcing clients to reconnect periodically (load balancing), preventing indefinitely long connections, and ensuring clients get updated connection parameters.

**Default:** `0` (disabled)

**Example:**

```typescript
// Close connections after 24 hours
new UwsAdapter(app, { maxLifetime: 24 * 60 }); // 1440 minutes

// Close connections after 1 hour
new UwsAdapter(app, { maxLifetime: 60 });

// Disable (allow indefinite connections)
new UwsAdapter(app, { maxLifetime: 0 });
```

### cors

```typescript
cors?: CorsOptions
```

CORS configuration for WebSocket connections.

**Example:**

```typescript
new UwsAdapter(app, {
  cors: {
    origin: 'https://example.com',
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});
```

See [CORS Options](#cors-options) for detailed configuration.

### moduleRef

```typescript
moduleRef?: ModuleRef | NestModuleRef
```

Module reference for dependency injection support. When provided, enables DI for guards, pipes, and filters.

Accepts either the NestJS `ModuleRef` (auto-wrapped) or our `ModuleRef` interface.

**Important:** Without `moduleRef`, guards/pipes/filters are instantiated directly and cannot have constructor dependencies.

**Example:**

```typescript
import { ModuleRef } from '@nestjs/core';

const app = await NestFactory.create(AppModule);
const moduleRef = app.get(ModuleRef);

const adapter = new UwsAdapter(app, {
  port: 8099,
  moduleRef, // Auto-wrapped internally
});

// Now guards can inject services
@Injectable()
class WsAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {} // DI works!
  
  canActivate(context: any): boolean {
    // For WebSocket context: args[0] = socket, args[1] = data payload
    const token = context.args[1]?.token;
    if (!token) return false;
    
    try {
      this.jwtService.verify(token);
      return true;
    } catch (error) {
      return false;
    }
  }
}
```

### SSL/TLS Options

#### cert_file_name

```typescript
cert_file_name?: string
```

Path to SSL certificate file. Required for HTTPS/WSS.

#### key_file_name

```typescript
key_file_name?: string
```

Path to SSL private key file. Required for HTTPS/WSS.

#### passphrase

```typescript
passphrase?: string
```

Optional passphrase for encrypted private key.

#### dh_params_file_name

```typescript
dh_params_file_name?: string
```

Optional path to Diffie-Hellman parameters file for enhanced security.

#### ssl_prefer_low_memory_usage

```typescript
ssl_prefer_low_memory_usage?: boolean
```

Optimize SSL for lower memory usage at the cost of some performance.

**Example:**

```typescript
new UwsAdapter(app, {
  port: 8099,
  cert_file_name: './certs/server.crt',
  key_file_name: './certs/server.key',
  passphrase: 'your-passphrase',
});
```

### uwsApp

```typescript
uwsApp?: uWS.TemplatedApp
```

Provide an existing uWebSockets.js app instance for HTTP + WebSocket integration (v2.0.0+).

**Example:**

```typescript
import { App } from 'uwestjs';

const uwsApp = App();

// HTTP adapter
const httpAdapter = new UwsPlatformAdapter(uwsApp);
const app = await NestFactory.create(AppModule, httpAdapter);

// WebSocket adapter (shares the same uWS instance)
const wsAdapter = new UwsAdapter(app, { uwsApp });
app.useWebSocketAdapter(wsAdapter);
```

---

## CORS Options

### CorsOptions

```typescript
interface CorsOptions {
  origin?: string | string[] | ((origin: string | null) => boolean);
  credentials?: boolean;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  maxAge?: number;
}
```

### origin

```typescript
origin?: string | string[] | ((origin: string | null) => boolean)
```

Allowed origins. Can be a string, array of strings, or a function that returns boolean.

**Default:** `undefined` (no CORS)

**Examples:**

```typescript
// Specific origin (recommended for production)
cors: { origin: 'https://example.com' }

// Allow all origins (use only for development/testing)
cors: { origin: '*' }

// Allow multiple origins
cors: { origin: ['https://example.com', 'https://app.example.com'] }

// Dynamic validation (recommended for flexible security)
cors: {
  origin: (origin) => {
    // Allow all subdomains of example.com
    return origin?.endsWith('.example.com') ?? false;
  }
}
```

**Security Warning:** Never use `origin: '*'` with `credentials: true` in production.

### credentials

```typescript
credentials?: boolean
```

Allow credentials (cookies, authorization headers, TLS client certificates).

**Default:** `false`

### methods

```typescript
methods?: string | string[]
```

Allowed HTTP methods for CORS preflight.

**Default:** `['GET', 'POST']`

### allowedHeaders

```typescript
allowedHeaders?: string | string[]
```

Headers that clients are allowed to send.

**Default:** `['Content-Type', 'Authorization']`

### exposedHeaders

```typescript
exposedHeaders?: string | string[]
```

Headers that are exposed to the client.

**Default:** `[]`

### maxAge

```typescript
maxAge?: number
```

How long (in seconds) the results of a preflight request can be cached.

**Default:** `86400` (24 hours)

---

## Methods

### registerGateway()

```typescript
registerGateway(gateway: object): void
```

Manually register a WebSocket gateway for message handling.

**Important:** We recommend calling `registerGateway()` manually over `bindMessageHandlers()` as this provides more metadata control and explicit lifecycle management.

**Parameters:**
- `gateway` - The gateway instance to register

**Example:**

```typescript
const app = await NestFactory.create(AppModule);
const adapter = new UwsAdapter(app, { port: 8099 });
app.useWebSocketAdapter(adapter);

// Manually register your gateway
const chatGateway = app.get(ChatGateway);
adapter.registerGateway(chatGateway);

await app.listen(3000);
```

**Why manual registration?**
- Better control over metadata scanning and handler registration timing
- Explicit gateway lifecycle management (afterInit, handleConnection, handleDisconnect)
- Clearer separation between adapter initialization and gateway registration
- Allows for custom handler registration strategies

### sendToClient()

```typescript
sendToClient(clientId: string, data: unknown): boolean
```

Send a message to a specific client.

**Parameters:**
- `clientId` - Client identifier
- `data` - Data to send (will be JSON stringified)

**Returns:** `true` if sent successfully, `false` otherwise

**Example:**

```typescript
const success = adapter.sendToClient('client-123', {
  event: 'notification',
  message: 'Hello!',
});
```

### broadcast()

```typescript
broadcast(data: unknown): void
```

Broadcast a message to all connected clients.

**Parameters:**
- `data` - Data to send (will be JSON stringified)

**Example:**

```typescript
adapter.broadcast({
  event: 'announcement',
  message: 'Server maintenance in 5 minutes',
});
```

### getClientCount()

```typescript
getClientCount(): number
```

Get the number of connected clients.

**Example:**

```typescript
const count = adapter.getClientCount();
console.log(`${count} clients connected`);
```

### getClientIds()

```typescript
getClientIds(): string[]
```

Get all connected client IDs.

**Example:**

```typescript
const clientIds = adapter.getClientIds();
clientIds.forEach(id => {
  console.log(`Client: ${id}`);
});
```

### hasClient()

```typescript
hasClient(clientId: string): boolean
```

Check if a client is connected.

**Example:**

```typescript
if (adapter.hasClient('client-123')) {
  adapter.sendToClient('client-123', { event: 'ping' });
}
```

### getSocket()

```typescript
getSocket(clientId: string): UwsSocket | undefined
```

Get a wrapped socket by client ID.

**Example:**

```typescript
const socket = adapter.getSocket('client-123');
if (socket) {
  socket.emit('message', { text: 'Hello!' });
}
```

### close()

```typescript
close(server: any): void
```

Close the server and all client connections.

**Example:**

```typescript
// Graceful shutdown
process.on('SIGTERM', () => {
  // Pass null when the adapter manages its own server lifecycle
  adapter.close(null);
  process.exit(0);
});
```

---

## Manual Gateway Registration

### Single Gateway

```typescript
const app = await NestFactory.create(AppModule);
const adapter = new UwsAdapter(app, { port: 8099 });
app.useWebSocketAdapter(adapter);

// Register gateway
const gateway = app.get(EventsGateway);
adapter.registerGateway(gateway);

await app.listen(3000);
```

### Multiple Gateways

```typescript
const app = await NestFactory.create(AppModule);
const adapter = new UwsAdapter(app, { port: 8099 });
app.useWebSocketAdapter(adapter);

// Register multiple gateways
const chatGateway = app.get(ChatGateway);
const gameGateway = app.get(GameGateway);
const notificationGateway = app.get(NotificationGateway);

adapter.registerGateway(chatGateway);
adapter.registerGateway(gameGateway);
adapter.registerGateway(notificationGateway);

await app.listen(3000);
```

**Important:** If multiple gateways register handlers for the same event, the last registered handler will be invoked. Use unique event names or namespacing to avoid conflicts:

```typescript
// Gateway1
@SubscribeMessage('chat:message')
handleChatMessage() { }

// Gateway2
@SubscribeMessage('game:message')
handleGameMessage() { }
```

---

## HTTP + WebSocket Integration

Starting from v2.0.0, you can share a single uWebSockets.js instance between HTTP and WebSocket:

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsPlatformAdapter, UwsAdapter, App } from 'uwestjs';

// Create shared uWS instance
const uwsApp = App();

// HTTP adapter
const httpAdapter = new UwsPlatformAdapter(uwsApp);
const app = await NestFactory.create(AppModule, httpAdapter);

// WebSocket adapter (shares the same uWS instance)
const wsAdapter = new UwsAdapter(app, { uwsApp });
app.useWebSocketAdapter(wsAdapter);

// Register gateways
const gateway = app.get(EventsGateway);
wsAdapter.registerGateway(gateway);

// Start server (HTTP adapter manages the listening port)
await app.listen(3000);
```

**Benefits:**
- Single port for both HTTP and WebSocket
- Better resource utilization
- Simplified deployment

---

## Examples

### Basic Setup

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsAdapter } from 'uwestjs';

const app = await NestFactory.create(AppModule);
const adapter = new UwsAdapter(app, { port: 8099 });
app.useWebSocketAdapter(adapter);

const gateway = app.get(EventsGateway);
adapter.registerGateway(gateway);

await app.listen(3000);
```

### With SSL/TLS

```typescript
const adapter = new UwsAdapter(app, {
  port: 8099,
  cert_file_name: './certs/server.crt',
  key_file_name: './certs/server.key',
  passphrase: 'your-passphrase',
});
```

### With CORS

```typescript
const adapter = new UwsAdapter(app, {
  port: 8099,
  cors: {
    origin: (origin) => origin?.endsWith('.example.com') ?? false,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});
```

### With Dependency Injection

```typescript
import { ModuleRef } from '@nestjs/core';

const moduleRef = app.get(ModuleRef);
const adapter = new UwsAdapter(app, {
  port: 8099,
  moduleRef, // Auto-wrapped internally
});
```

### Complete Configuration

```typescript
import { NestFactory } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import { UwsAdapter, SHARED_COMPRESSOR } from 'uwestjs';

const app = await NestFactory.create(AppModule);
const moduleRef = app.get(ModuleRef);

const adapter = new UwsAdapter(app, {
  // Server configuration
  port: 8099,
  path: '/ws',
  
  // Performance tuning
  maxPayloadLength: 1024 * 1024, // 1MB
  idleTimeout: 300, // 5 minutes
  compression: SHARED_COMPRESSOR,
  
  // CORS configuration
  cors: {
    origin: (origin) => origin?.endsWith('.example.com') ?? false,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 3600,
  },
  
  // Enable DI for guards/pipes/filters (auto-wrapped)
  moduleRef,
});

app.useWebSocketAdapter(adapter);

// Register gateways
const gateway = app.get(EventsGateway);
adapter.registerGateway(gateway);

await app.listen(3000);
```

---

## See Also

- [Socket API](./Socket.md)
- [Broadcasting](./Broadcasting.md)
- [Decorators](./Decorators.md)
- [Rooms](./Rooms.md)
- [Middleware](./Middleware.md)
- [Lifecycle](./Lifecycle.md)
