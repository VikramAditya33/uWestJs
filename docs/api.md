# API Reference

Complete API documentation for uWestJS.

## Table of Contents

- [UwsAdapter](#uwsadapter)
- [UwsSocket](#uwssocket)
- [BroadcastOperator](#broadcastoperator)
- [Configuration Options](#configuration-options)
- [Decorators](#decorators)
- [Room Operations](#room-operations)
- [Middleware](#middleware)
- [Exception Handling](#exception-handling)
- [Lifecycle Hooks](#lifecycle-hooks)

---

## UwsAdapter

The main adapter class that integrates uWebSockets.js with NestJS.

### Constructor

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

### Methods

#### registerGateway()

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

#### create()

```typescript
create(port: number, options?: any): Promise<uWS.TemplatedApp>
```

Create the uWebSockets.js server. Called internally by NestJS during application initialization.

**Note:** The adapter uses the port configured in constructor options (default: 8099), not the port parameter passed to this method.

#### bindClientConnect()

```typescript
bindClientConnect(server: any, callback: Function): void
```

Bind client connection handler. Sets up WebSocket routes and lifecycle handlers. Called internally by NestJS.

#### close()

```typescript
close(server: any): void
```

Close the server and all client connections.

**Example:**

```typescript
// Graceful shutdown
process.on('SIGTERM', () => {
  adapter.close(null);
  process.exit(0);
});
```

#### sendToClient()

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

#### broadcast()

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

#### getClientCount()

```typescript
getClientCount(): number
```

Get the number of connected clients.

**Example:**

```typescript
const count = adapter.getClientCount();
console.log(`${count} clients connected`);
```

#### getClientIds()

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

#### hasClient()

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

#### getSocket()

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

---

## UwsSocket

Socket wrapper that provides a Socket.IO-like API over native uWebSockets.js. This is the object you receive when using `@ConnectedSocket()` decorator.

### Properties

#### id

```typescript
readonly id: string
```

Unique identifier for this socket connection.

**Example:**

```typescript
@SubscribeMessage('message')
handleMessage(@ConnectedSocket() client: UwsSocket) {
  console.log(`Message from client: ${client.id}`);
}
```

#### data

```typescript
data: TData
```

Custom data attached to this socket. Use this to store user information, session data, authentication tokens, etc.

**Example:**

```typescript
@SubscribeMessage('authenticate')
handleAuth(
  @MessageBody() token: string,
  @ConnectedSocket() client: UwsSocket,
) {
  // Verify token and attach user data
  const user = this.authService.verify(token);
  client.data = { user, authenticated: true };
}

@SubscribeMessage('secure-action')
handleSecure(@ConnectedSocket() client: UwsSocket) {
  if (!client.data?.authenticated) {
    throw new WsException('Not authenticated');
  }
  // Access user data
  console.log(`User ${client.data.user.name} performed action`);
}
```

#### broadcast

```typescript
readonly broadcast: BroadcastOperator
```

Broadcast operator for sending to multiple clients, excluding the sender.

**Example:**

```typescript
@SubscribeMessage('message')
handleMessage(
  @MessageBody() data: string,
  @ConnectedSocket() client: UwsSocket,
) {
  // Send to all clients except the sender
  client.broadcast.emit('message', data);
}
```

### Methods

#### emit()

```typescript
emit(event: string, data?: TEmitData): void
```

Emit an event to this specific client.

**Parameters:**
- `event` - Event name
- `data` - Optional data to send

**Example:**

```typescript
@SubscribeMessage('request-data')
handleRequest(@ConnectedSocket() client: UwsSocket) {
  client.emit('response', { status: 'ok', data: [1, 2, 3] });
}

// Multiple emits
client.emit('notification', { type: 'info', message: 'Welcome' });
client.emit('heartbeat'); // No data needed
```

**Throws:**
- Error if message cannot be serialized to JSON
- Error if message is dropped due to backpressure

#### disconnect()

```typescript
disconnect(): void
```

Disconnect this client. Closes the WebSocket connection.

**Example:**

```typescript
@SubscribeMessage('logout')
handleLogout(@ConnectedSocket() client: UwsSocket) {
  client.emit('logged-out', { message: 'Goodbye!' });
  client.disconnect();
}

// Disconnect idle clients
if (client.getBufferedAmount() > 1024 * 1024) {
  console.log('Client is too slow, disconnecting');
  client.disconnect();
}
```

#### join()

```typescript
join(room: string | string[]): void
```

Join one or more rooms.

**Parameters:**
- `room` - Room name or array of room names

**Example:**

```typescript
// Join single room
client.join('lobby');

// Join multiple rooms
client.join(['game-1', 'chat-general']);

// Join room based on user data
@SubscribeMessage('join-game')
handleJoinGame(
  @MessageBody() gameId: string,
  @ConnectedSocket() client: UwsSocket,
) {
  client.join(`game:${gameId}`);
  client.to(`game:${gameId}`).emit('player-joined', {
    playerId: client.id,
    username: client.data.user.name,
  });
}
```

#### leave()

```typescript
leave(room: string | string[]): void
```

Leave one or more rooms.

**Parameters:**
- `room` - Room name or array of room names

**Example:**

```typescript
// Leave single room
client.leave('lobby');

// Leave multiple rooms
client.leave(['game-1', 'chat-general']);

// Leave room on disconnect
@SubscribeMessage('leave-game')
handleLeaveGame(
  @MessageBody() gameId: string,
  @ConnectedSocket() client: UwsSocket,
) {
  client.leave(`game:${gameId}`);
  client.to(`game:${gameId}`).emit('player-left', {
    playerId: client.id,
  });
}
```

#### to()

```typescript
to(room: string | string[]): BroadcastOperator
```

Emit to specific room(s), excluding the sender (Socket.IO-compatible behavior).

**Parameters:**
- `room` - Room name or array of room names

**Returns:** BroadcastOperator for chaining

**Example:**

```typescript
// Send to single room, excluding sender
client.to('room1').emit('message', data);

// Send to multiple rooms, excluding sender
client.to(['room1', 'room2']).emit('message', data);

// Chaining
client.to('room1').to('room2').emit('message', data);

// Game example
@SubscribeMessage('game-move')
handleMove(
  @MessageBody() move: any,
  @ConnectedSocket() client: UwsSocket,
) {
  const gameId = client.data.gameId;
  // Broadcast move to all players in the game except the sender
  client.to(`game:${gameId}`).emit('move-made', {
    playerId: client.id,
    move,
  });
}
```

#### getBufferedAmount()

```typescript
getBufferedAmount(): number
```

Get the amount of buffered (backpressured) data for this socket. Returns the number of bytes waiting to be sent.

**Returns:** Number of bytes buffered

**Example:**

```typescript
const buffered = client.getBufferedAmount();
if (buffered > 1024 * 1024) {
  console.log('Client is slow, consider disconnecting');
  client.disconnect();
}

// Monitor backpressure before sending large data
if (client.getBufferedAmount() < 100000) {
  client.emit('large-data', largePayload);
} else {
  console.log('Client has backpressure, skipping large data');
}
```

---

## BroadcastOperator

Broadcast operator for sending messages to multiple clients with room targeting and client exclusion.

### Methods

#### to()

```typescript
to(room: string | string[]): BroadcastOperator
```

Target specific room(s) for broadcasting. Can be chained multiple times to target multiple rooms.

**Parameters:**
- `room` - Room name or array of room names

**Returns:** New BroadcastOperator for chaining

**Example:**

```typescript
// Target single room
client.broadcast.to('room1').emit('message', data);

// Target multiple rooms
client.broadcast.to(['room1', 'room2']).emit('message', data);

// Chaining multiple to() calls
client.broadcast.to('room1').to('room2').emit('message', data);

// Empty array = broadcast to zero rooms (no clients)
client.broadcast.to([]).emit('message', data);
```

#### except()

```typescript
except(clientId: string | string[]): BroadcastOperator
```

Exclude specific client(s) from broadcast. Multiple `except()` calls will accumulate excluded clients.

**Parameters:**
- `clientId` - Client ID or array of client IDs to exclude

**Returns:** New BroadcastOperator for chaining

**Example:**

```typescript
// Exclude single client
client.broadcast.except('client-1').emit('message', data);

// Exclude multiple clients
client.broadcast.except(['client-1', 'client-2']).emit('message', data);

// Chaining with to()
client.broadcast
  .to('room1')
  .except('client-1')
  .emit('message', data);

// Multiple except() calls accumulate
client.broadcast
  .except('client-1')
  .except('client-2')
  .emit('message', data); // Both excluded

// Empty array = exclude nobody
client.broadcast.except([]).emit('message', data);
```

#### emit()

```typescript
emit(event: string, data?: TEmitData): void
```

Emit event to all targeted clients.

**Parameters:**
- `event` - Event name
- `data` - Optional data to send

**Example:**

```typescript
// Broadcast to all clients
client.broadcast.emit('announcement', { message: 'Server restart in 5 min' });

// Broadcast to specific room
client.broadcast.to('game-1').emit('game-update', { status: 'started' });

// Broadcast to room, excluding specific clients
client.broadcast
  .to('chat')
  .except(['client-1', 'client-2'])
  .emit('message', { text: 'Hello!' });

// Complex targeting
client.broadcast
  .to(['room1', 'room2'])
  .except('client-1')
  .emit('notification', { type: 'info' });
```

### Usage Patterns

#### Broadcast to Everyone

```typescript
// Send to all connected clients
client.broadcast.emit('server-message', { text: 'Hello everyone!' });
```

#### Broadcast to Room

```typescript
// Send to all clients in a room
client.broadcast.to('lobby').emit('player-count', { count: 10 });
```

#### Broadcast to Multiple Rooms

```typescript
// Send to clients in multiple rooms
client.broadcast
  .to(['premium-users', 'beta-testers'])
  .emit('feature-announcement', { feature: 'New Dashboard' });
```

#### Broadcast with Exclusions

```typescript
// Send to room but exclude specific clients
client.broadcast
  .to('game-room')
  .except(['spectator-1', 'spectator-2'])
  .emit('game-state', gameData);
```

---

## Configuration Options

### UwsAdapterOptions

Configuration options for the UwsAdapter.

```typescript
interface UwsAdapterOptions {
  port?: number;
  maxPayloadLength?: number;
  idleTimeout?: number;
  compression?: uWS.CompressOptions;
  path?: string;
  cors?: CorsOptions;
  moduleRef?: ModuleRef;
}
```

#### port

```typescript
port?: number
```

WebSocket server port.

**Default:** `8099`

**Example:**

```typescript
new UwsAdapter(app, { port: 3001 });
```

#### maxPayloadLength

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

#### idleTimeout

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

#### compression

```typescript
compression?: uWS.CompressOptions
```

Compression mode for WebSocket messages.

**Default:** `uWS.SHARED_COMPRESSOR`

**Options:**
- `uWS.DISABLED` - No compression
- `uWS.SHARED_COMPRESSOR` - Shared compressor (recommended)
- `uWS.DEDICATED_COMPRESSOR` - Dedicated compressor per connection

**Example:**

```typescript
import * as uWS from 'uWebSockets.js';

// Disable compression
new UwsAdapter(app, { compression: uWS.DISABLED });

// Use dedicated compressor (higher memory, better compression)
new UwsAdapter(app, { compression: uWS.DEDICATED_COMPRESSOR });
```

#### path

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

#### cors

```typescript
cors?: CorsOptions
```

CORS configuration for WebSocket connections.

**Example:**

```typescript
new UwsAdapter(app, {
  cors: {
    origin: 'https://example.com', // Specific origin for security
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});
```

See [CorsOptions](#corsoptions) for detailed configuration.

#### moduleRef

```typescript
moduleRef?: ModuleRef
```

Module reference for dependency injection support. When provided, enables DI for guards, pipes, and filters.

**Important:** Without `moduleRef`, guards/pipes/filters are instantiated directly and cannot have constructor dependencies.

**Example:**

```typescript
import { ModuleRef } from '@nestjs/core';

const app = await NestFactory.create(AppModule);
const moduleRef = app.get(ModuleRef);

const adapter = new UwsAdapter(app, {
  port: 8099,
  moduleRef, // Enable DI support
});

// Now guards can inject services
@Injectable()
class WsAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {} // DI works!
  
  canActivate(context: any): boolean {
    try {
      const token = context.args[1]?.token;
      if (!token) return false;
      
      this.jwtService.verify(token);
      return true;
    } catch {
      return false;
    }
  }
}
```

### CorsOptions

CORS configuration options.

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

#### origin

```typescript
origin?: string | string[] | ((origin: string | null) => boolean)
```

Allowed origins. Can be a string, array of strings, or a function that returns boolean.

**Default:** `undefined` (no CORS)

**Note:** The origin parameter can be null in privacy-sensitive contexts (sandboxed iframes, local files).

**Examples:**

```typescript
// Specific origin (recommended for production)
cors: { origin: 'https://example.com' }

// Allow all origins (use only for development/testing)
cors: { origin: '*' }

// Allow multiple origins
cors: { origin: 'https://example.com' }

// Allow multiple origins
cors: { origin: ['https://example.com', 'https://app.example.com'] }

// Dynamic validation (recommended for flexible security)
cors: {
  origin: (origin) => {
    // Allow all subdomains of example.com
    return origin?.endsWith('.example.com') ?? false;
  }
}

// Complex validation with multiple allowed domains
cors: {
  origin: (origin) => {
    if (!origin) return false; // Reject null origins
    const allowed = ['example.com', 'test.com'];
    return allowed.some(domain => origin.includes(domain));
  }
}
```

**Security Warning:** Never use `origin: '*'` with `credentials: true` in production. This combination allows any origin to make authenticated requests, which is a serious security vulnerability. Always specify exact origins or use a validation function.

#### credentials

```typescript
credentials?: boolean
```

Allow credentials (cookies, authorization headers, TLS client certificates).

**Default:** `false`

**Example:**

```typescript
cors: {
  origin: 'https://example.com',
  credentials: true, // Allow cookies and auth headers
}
```

#### methods

```typescript
methods?: string | string[]
```

Allowed HTTP methods for CORS preflight.

**Default:** `['GET', 'POST']`

**Example:**

```typescript
cors: {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}
```

#### allowedHeaders

```typescript
allowedHeaders?: string | string[]
```

Headers that clients are allowed to send.

**Default:** `['Content-Type', 'Authorization']`

**Example:**

```typescript
cors: {
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Custom-Header'],
}
```

#### exposedHeaders

```typescript
exposedHeaders?: string | string[]
```

Headers that are exposed to the client.

**Default:** `[]`

**Example:**

```typescript
cors: {
  exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
}
```

#### maxAge

```typescript
maxAge?: number
```

How long (in seconds) the results of a preflight request can be cached.

**Default:** `86400` (24 hours)

**Example:**

```typescript
cors: {
  maxAge: 3600, // 1 hour
}
```

### Complete Configuration Example

```typescript
import { NestFactory } from '@nestjs/core';
import { ModuleRef } from '@nestjs/core';
import { UwsAdapter } from 'uwestjs';
import * as uWS from 'uWebSockets.js';

const app = await NestFactory.create(AppModule);
const moduleRef = app.get(ModuleRef);

const adapter = new UwsAdapter(app, {
  // Server configuration
  port: 8099,
  path: '/ws',
  
  // Performance tuning
  maxPayloadLength: 1024 * 1024, // 1MB
  idleTimeout: 300, // 5 minutes
  compression: uWS.SHARED_COMPRESSOR,
  
  // CORS configuration
  cors: {
    origin: (origin) => origin?.endsWith('.example.com') ?? false,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 3600,
  },
  
  // Enable DI for guards/pipes/filters
  moduleRef,
});

app.useWebSocketAdapter(adapter);
```

---

## Decorators

uWestJS supports all standard NestJS WebSocket decorators.

### @WebSocketGateway()

Marks a class as a WebSocket gateway.

```typescript
import { WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway {
  // Gateway methods
}
```

**Note:** Gateway options (port, namespace, etc.) are ignored by uWestJS. Configure the adapter directly instead.

### @SubscribeMessage()

Marks a method as a message handler for a specific event.

```typescript
import { SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway {
  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: string,
    @ConnectedSocket() client: any,
  ) {
    return { event: 'response', data: `Echo: ${data}` };
  }
}
```

**Return Values:**
- Return an object to send a response: `{ event: 'response', data: ... }`
- Return `undefined` or `void` to send no response
- Return a Promise for async handlers

**Example with async:**

```typescript
@SubscribeMessage('fetch-data')
async handleFetchData(@MessageBody() id: string) {
  const data = await this.dataService.findById(id);
  return { event: 'data', data };
}
```

### @MessageBody()

Extracts the message data from the incoming message.

```typescript
@SubscribeMessage('message')
handleMessage(@MessageBody() data: string) {
  console.log('Received:', data);
}
```

**With validation:**

```typescript
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';

class MessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;
}

@UsePipes(new ValidationPipe())
@SubscribeMessage('message')
handleMessage(@MessageBody() dto: MessageDto) {
  console.log('Valid message:', dto.content);
}
```

### @ConnectedSocket()

Injects the connected socket instance.

```typescript
@SubscribeMessage('message')
handleMessage(
  @MessageBody() data: string,
  @ConnectedSocket() client: UwsSocket,
) {
  console.log(`Message from ${client.id}`);
  client.emit('response', { received: true });
}
```

**Accessing socket data:**

```typescript
@SubscribeMessage('secure-action')
handleSecure(@ConnectedSocket() client: UwsSocket) {
  const user = client.data.user;
  console.log(`User ${user.name} performed action`);
}
```

### @Payload()

Alias for `@MessageBody()`. Works identically.

```typescript
import { Payload } from 'uwestjs';

@SubscribeMessage('message')
handleMessage(@Payload() data: string) {
  console.log('Received:', data);
}
```

### Decorator Combinations

You can use multiple decorators together:

```typescript
@SubscribeMessage('chat-message')
@UseGuards(WsAuthGuard)
@UsePipes(new ValidationPipe())
@UseFilters(WsExceptionFilter)
handleChatMessage(
  @MessageBody() dto: ChatMessageDto,
  @ConnectedSocket() client: UwsSocket,
) {
  // Handler logic
}
```

---

## Room Operations

Rooms allow you to organize clients into groups for targeted broadcasting.

### Joining Rooms

```typescript
// Join single room
client.join('lobby');

// Join multiple rooms at once
client.join(['game-1', 'chat-general', 'notifications']);

// Join room based on user data
@SubscribeMessage('join-game')
handleJoinGame(
  @MessageBody() gameId: string,
  @ConnectedSocket() client: UwsSocket,
) {
  const roomName = `game:${gameId}`;
  client.join(roomName);
  
  // Notify others in the room
  client.to(roomName).emit('player-joined', {
    playerId: client.id,
    username: client.data.user.name,
  });
  
  return { event: 'joined', room: roomName };
}
```

### Leaving Rooms

```typescript
// Leave single room
client.leave('lobby');

// Leave multiple rooms at once
client.leave(['game-1', 'chat-general']);

// Leave room on disconnect
@SubscribeMessage('leave-game')
handleLeaveGame(
  @MessageBody() gameId: string,
  @ConnectedSocket() client: UwsSocket,
) {
  const roomName = `game:${gameId}`;
  client.leave(roomName);
  
  // Notify others
  client.to(roomName).emit('player-left', {
    playerId: client.id,
  });
}
```

**Note:** Clients are automatically removed from all rooms when they disconnect.

### Broadcasting to Rooms

```typescript
// Broadcast to single room (excluding sender)
client.to('room1').emit('message', data);

// Broadcast to multiple rooms (excluding sender)
client.to(['room1', 'room2']).emit('message', data);

// Broadcast to room including sender
client.emit('message', data); // Send to self
client.to('room1').emit('message', data); // Send to room

// Or use broadcast to exclude sender
client.broadcast.to('room1').emit('message', data);
```

### Room Patterns

#### Lobby Pattern

```typescript
@WebSocketGateway()
export class LobbyGateway {
  @SubscribeMessage('join-lobby')
  handleJoinLobby(@ConnectedSocket() client: UwsSocket) {
    client.join('lobby');
    
    // Announce to lobby
    client.to('lobby').emit('user-joined', {
      userId: client.id,
      username: client.data.user.name,
    });
    
    // Send lobby state to new user
    const lobbyUsers = this.getLobbyUsers();
    client.emit('lobby-state', { users: lobbyUsers });
  }
  
  @SubscribeMessage('leave-lobby')
  handleLeaveLobby(@ConnectedSocket() client: UwsSocket) {
    client.leave('lobby');
    client.to('lobby').emit('user-left', {
      userId: client.id,
    });
  }
}
```

#### Game Room Pattern

```typescript
@WebSocketGateway()
export class GameGateway {
  @SubscribeMessage('create-game')
  handleCreateGame(
    @MessageBody() settings: any,
    @ConnectedSocket() client: UwsSocket,
  ) {
    const gameId = this.generateGameId();
    const roomName = `game:${gameId}`;
    
    client.join(roomName);
    client.data.gameId = gameId;
    
    return { event: 'game-created', gameId };
  }
  
  @SubscribeMessage('join-game')
  handleJoinGame(
    @MessageBody() gameId: string,
    @ConnectedSocket() client: UwsSocket,
  ) {
    const roomName = `game:${gameId}`;
    client.join(roomName);
    client.data.gameId = gameId;
    
    // Notify all players
    client.to(roomName).emit('player-joined', {
      playerId: client.id,
      username: client.data.user.name,
    });
  }
  
  @SubscribeMessage('game-action')
  handleGameAction(
    @MessageBody() action: any,
    @ConnectedSocket() client: UwsSocket,
  ) {
    const gameId = client.data.gameId;
    if (!gameId) {
      throw new WsException('Not in a game');
    }
    
    // Broadcast action to all players in the game
    client.to(`game:${gameId}`).emit('game-update', {
      playerId: client.id,
      action,
    });
  }
}
```

#### Chat Room Pattern

```typescript
@WebSocketGateway()
export class ChatGateway {
  @SubscribeMessage('join-channel')
  handleJoinChannel(
    @MessageBody() channel: string,
    @ConnectedSocket() client: UwsSocket,
  ) {
    // Leave previous channel if any
    if (client.data.currentChannel) {
      client.leave(client.data.currentChannel);
    }
    
    // Join new channel
    client.join(channel);
    client.data.currentChannel = channel;
    
    // Announce to channel
    client.to(channel).emit('user-joined-channel', {
      userId: client.id,
      username: client.data.user.name,
      channel,
    });
  }
  
  @SubscribeMessage('send-message')
  handleSendMessage(
    @MessageBody() message: string,
    @ConnectedSocket() client: UwsSocket,
  ) {
    const channel = client.data.currentChannel;
    if (!channel) {
      throw new WsException('Not in a channel');
    }
    
    // Broadcast to channel (including sender)
    client.emit('message', {
      userId: client.id,
      username: client.data.user.name,
      message,
      timestamp: Date.now(),
    });
    
    client.to(channel).emit('message', {
      userId: client.id,
      username: client.data.user.name,
      message,
      timestamp: Date.now(),
    });
  }
}
```

#### Notification Room Pattern

```typescript
@WebSocketGateway()
export class NotificationGateway {
  private clients = new Map<string, UwsSocket>();
  
  @SubscribeMessage('subscribe-notifications')
  handleSubscribe(
    @MessageBody() topics: string[],
    @ConnectedSocket() client: UwsSocket,
  ) {
    // Store client reference for later use
    this.clients.set(client.id, client);
    
    // Subscribe to multiple notification topics
    topics.forEach(topic => {
      client.join(`notifications:${topic}`);
    });
    
    return { event: 'subscribed', topics };
  }
  
  // Called from a service to send notifications
  sendNotification(topic: string, notification: any) {
    const roomName = `notifications:${topic}`;
    
    // Get any client to use its broadcast capability
    const anyClient = this.clients.values().next().value;
    if (anyClient) {
      anyClient.broadcast.to(roomName).emit('notification', {
        topic,
        ...notification,
      });
    }
  }
  
  // Clean up on disconnect
  handleDisconnect(client: UwsSocket) {
    this.clients.delete(client.id);
  }
}
```

**Alternative Pattern:** If you need to broadcast without a client reference, inject the adapter:

```typescript
@WebSocketGateway()
export class NotificationGateway {
  constructor(
    @Inject('WS_ADAPTER') private adapter: UwsAdapter
  ) {}
  
  sendNotification(topic: string, notification: any) {
    // Direct adapter access for broadcasting
    this.adapter.broadcast.to(`notifications:${topic}`).emit('notification', {
      topic,
      ...notification,
    });
  }
}

// In your module, provide the adapter:
@Module({
  providers: [
    NotificationGateway,
    {
      provide: 'WS_ADAPTER',
      useFactory: () => {
        // Return your adapter instance
        // You'll need to store it during app initialization
        return globalAdapterInstance;
      },
    },
  ],
})
export class AppModule {}
```

### Room Naming Conventions

Use consistent naming patterns for better organization:

```typescript
// Prefix-based naming
`game:${gameId}`        // game:abc123
`chat:${channelId}`     // chat:general
`user:${userId}`        // user:12345
`notifications:${type}` // notifications:orders

// Hierarchical naming
`company:${companyId}:department:${deptId}` // company:1:department:5

// Feature-based naming
`live-feed:${feedId}`
`auction:${auctionId}`
`collaboration:${docId}`
```

---

## Middleware

uWestJS supports all NestJS middleware: Guards, Pipes, Filters, and Interceptors.

### Guards

Guards determine whether a request should be handled by the route handler.

#### Creating a Guard

```typescript
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient();
    const data = context.switchToWs().getData();
    
    // Check authentication
    return client.data?.authenticated === true;
  }
}
```

#### Using Guards

```typescript
import { UseGuards } from '@nestjs/common';

@WebSocketGateway()
export class SecureGateway {
  // Method-level guard
  @UseGuards(WsAuthGuard)
  @SubscribeMessage('secure-action')
  handleSecureAction(@MessageBody() data: any) {
    return { event: 'success', data };
  }
  
  // Multiple guards (executed in order)
  @UseGuards(WsAuthGuard, WsRoleGuard)
  @SubscribeMessage('admin-action')
  handleAdminAction(@MessageBody() data: any) {
    return { event: 'admin-success', data };
  }
}

// Class-level guard (applies to all handlers)
@UseGuards(WsAuthGuard)
@WebSocketGateway()
export class ProtectedGateway {
  @SubscribeMessage('action1')
  handleAction1() { }
  
  @SubscribeMessage('action2')
  handleAction2() { }
}
```

#### Guard with Dependency Injection

**Important:** To use DI in guards, provide `moduleRef` to the adapter.

```typescript
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private jwtService: JwtService) {} // DI works with moduleRef
  
  canActivate(context: ExecutionContext): boolean {
    const data = context.switchToWs().getData();
    const token = data?.token;
    
    if (!token) return false;
    
    try {
      const payload = this.jwtService.verify(token);
      const client = context.switchToWs().getClient();
      client.data = { user: payload, authenticated: true };
      return true;
    } catch {
      return false;
    }
  }
}

// Enable DI in main.ts
const moduleRef = app.get(ModuleRef);
const adapter = new UwsAdapter(app, { port: 8099, moduleRef });
```

#### Async Guards

```typescript
@Injectable()
export class WsAsyncAuthGuard implements CanActivate {
  constructor(private authService: AuthService) {}
  
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const data = context.switchToWs().getData();
    const token = data?.token;
    
    if (!token) return false;
    
    const user = await this.authService.validateToken(token);
    if (!user) return false;
    
    const client = context.switchToWs().getClient();
    client.data = { user, authenticated: true };
    return true;
  }
}
```

### Pipes

Pipes transform and validate incoming data.

#### Creating a Pipe

```typescript
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseIntPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const val = parseInt(value, 10);
    if (isNaN(val)) {
      throw new BadRequestException('Value must be a number');
    }
    return val;
  }
}
```

#### Using Pipes

```typescript
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';

class MessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;
  
  @IsInt()
  @Min(1)
  priority: number;
}

@WebSocketGateway()
export class ChatGateway {
  // Method-level pipe
  @UsePipes(new ValidationPipe())
  @SubscribeMessage('message')
  handleMessage(@MessageBody() dto: MessageDto) {
    return { event: 'message-received', data: dto };
  }
  
  // Parameter-level pipe
  @SubscribeMessage('get-user')
  handleGetUser(@MessageBody(ParseIntPipe) userId: number) {
    return { event: 'user', data: this.findUser(userId) };
  }
  
  // Multiple pipes
  @UsePipes(ValidationPipe, TransformPipe)
  @SubscribeMessage('complex')
  handleComplex(@MessageBody() data: any) {
    return { event: 'processed', data };
  }
}

// Class-level pipe (applies to all handlers)
@UsePipes(new ValidationPipe({ transform: true }))
@WebSocketGateway()
export class ValidatedGateway {
  @SubscribeMessage('action1')
  handleAction1(@MessageBody() dto: Dto1) { }
  
  @SubscribeMessage('action2')
  handleAction2(@MessageBody() dto: Dto2) { }
}
```

#### Built-in Pipes

```typescript
import {
  ValidationPipe,
  ParseIntPipe,
  ParseBoolPipe,
  ParseArrayPipe,
} from '@nestjs/common';

@WebSocketGateway()
export class ExampleGateway {
  @SubscribeMessage('example')
  handleExample(
    @MessageBody('id', ParseIntPipe) id: number,
    @MessageBody('active', ParseBoolPipe) active: boolean,
    @MessageBody('tags', ParseArrayPipe) tags: string[],
  ) {
    // All parameters are properly typed and validated
  }
}
```

#### Async Pipes

```typescript
@Injectable()
export class AsyncValidationPipe implements PipeTransform {
  constructor(private validationService: ValidationService) {}
  
  async transform(value: any): Promise<any> {
    const isValid = await this.validationService.validate(value);
    if (!isValid) {
      throw new BadRequestException('Validation failed');
    }
    return value;
  }
}
```

### Filters

Exception filters handle errors thrown during message handling.

#### Creating a Filter

```typescript
import { Catch, ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { WsException } from 'uwestjs';

@Catch(WsException)
export class WsExceptionFilter implements ExceptionFilter {
  catch(exception: WsException, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const error = exception.getError();
    
    client.emit('error', {
      message: error.message,
      code: error.error,
      timestamp: new Date().toISOString(),
    });
  }
}

// Catch all exceptions
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    
    const message = exception instanceof Error
      ? exception.message
      : 'Unknown error';
    
    client.emit('error', {
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

#### Using Filters

```typescript
import { UseFilters } from '@nestjs/common';

@WebSocketGateway()
export class ChatGateway {
  // Method-level filter
  @UseFilters(WsExceptionFilter)
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: string) {
    if (!data) {
      throw new WsException('Message cannot be empty');
    }
    return { event: 'success' };
  }
  
  // Multiple filters
  @UseFilters(WsExceptionFilter, ValidationExceptionFilter)
  @SubscribeMessage('complex')
  handleComplex(@MessageBody() data: any) {
    // Handler logic
  }
}

// Class-level filter (applies to all handlers)
@UseFilters(AllExceptionsFilter)
@WebSocketGateway()
export class ProtectedGateway {
  @SubscribeMessage('action1')
  handleAction1() { }
  
  @SubscribeMessage('action2')
  handleAction2() { }
}
```

#### Filter with Dependency Injection

```typescript
@Injectable()
@Catch()
export class LoggingExceptionFilter implements ExceptionFilter {
  constructor(private logger: LoggerService) {} // DI works with moduleRef
  
  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const message = exception instanceof Error
      ? exception.message
      : 'Unknown error';
    
    this.logger.error(`WebSocket error for client ${client.id}: ${message}`);
    
    client.emit('error', { message });
  }
}
```

### Combining Middleware

You can combine guards, pipes, and filters:

```typescript
@UseGuards(WsAuthGuard)
@UsePipes(new ValidationPipe())
@UseFilters(WsExceptionFilter)
@WebSocketGateway()
export class SecureGateway {
  @SubscribeMessage('secure-action')
  handleSecureAction(@MessageBody() dto: ActionDto) {
    // 1. Guard checks authentication
    // 2. Pipe validates and transforms data
    // 3. Handler executes
    // 4. Filter catches any exceptions
    return { event: 'success', data: dto };
  }
}
```

### Execution Order

Middleware executes in this order:

1. **Guards** - Check if request should be processed
2. **Pipes** - Transform and validate data
3. **Handler** - Execute the message handler
4. **Filters** - Catch any exceptions (if thrown)

```typescript
@UseGuards(Guard1, Guard2)        // 1. Guards execute first
@UsePipes(Pipe1, Pipe2)           // 2. Then pipes
@UseFilters(Filter1, Filter2)     // 4. Filters catch exceptions
@SubscribeMessage('action')
handleAction(@MessageBody() data: any) {
  // 3. Handler executes
}
```

---

## Exception Handling

### WsException

WebSocket exception that can be caught by exception filters.

```typescript
import { WsException } from 'uwestjs';
```

#### Constructor

```typescript
constructor(message: string | object, error?: string)
```

**Parameters:**
- `message` - Error message or error object
- `error` - Optional error type/code

**Examples:**

```typescript
// Simple message
throw new WsException('Invalid input');

// With error code
throw new WsException('Unauthorized', 'AUTH_ERROR');

// With object message
throw new WsException({
  field: 'email',
  message: 'Invalid email format',
}, 'VALIDATION_ERROR');
```

#### Methods

##### getError()

```typescript
getError(): { message: string | object; error?: string }
```

Gets the error response object with consistent structure.

**Example:**

```typescript
try {
  throw new WsException('Something went wrong', 'ERROR_CODE');
} catch (exception) {
  const error = exception.getError();
  // { message: 'Something went wrong', error: 'ERROR_CODE' }
}
```

### Using WsException

#### In Handlers

```typescript
@WebSocketGateway()
export class ChatGateway {
  @SubscribeMessage('send-message')
  handleSendMessage(
    @MessageBody() message: string,
    @ConnectedSocket() client: UwsSocket,
  ) {
    if (!client.data?.authenticated) {
      throw new WsException('Not authenticated', 'AUTH_REQUIRED');
    }
    
    if (!message || message.trim().length === 0) {
      throw new WsException('Message cannot be empty', 'INVALID_MESSAGE');
    }
    
    if (message.length > 1000) {
      throw new WsException('Message too long', 'MESSAGE_TOO_LONG');
    }
    
    // Process message
    return { event: 'message-sent', data: { id: '123' } };
  }
}
```

#### In Guards

```typescript
@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient();
    
    if (!client.data?.token) {
      throw new WsException('Token required', 'TOKEN_MISSING');
    }
    
    if (!this.validateToken(client.data.token)) {
      throw new WsException('Invalid token', 'TOKEN_INVALID');
    }
    
    return true;
  }
}
```

#### In Pipes

```typescript
@Injectable()
export class ValidationPipe implements PipeTransform {
  transform(value: any): any {
    if (!value) {
      throw new WsException('Value is required', 'VALIDATION_ERROR');
    }
    
    if (typeof value !== 'string') {
      throw new WsException('Value must be a string', 'TYPE_ERROR');
    }
    
    return value;
  }
}
```

### Custom Exception Filters

Create custom filters to handle exceptions:

```typescript
import { Catch, ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { WsException } from 'uwestjs';

@Catch(WsException)
export class CustomWsExceptionFilter implements ExceptionFilter {
  catch(exception: WsException, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const error = exception.getError();
    
    // Send formatted error to client
    client.emit('error', {
      success: false,
      error: {
        code: error.error || 'UNKNOWN_ERROR',
        message: error.message,
        timestamp: new Date().toISOString(),
      },
    });
  }
}

// Use the filter
@UseFilters(CustomWsExceptionFilter)
@WebSocketGateway()
export class ChatGateway {
  // Handlers
}
```

### Error Response Patterns

#### Standard Error Response

```typescript
@Catch(WsException)
export class StandardErrorFilter implements ExceptionFilter {
  catch(exception: WsException, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const error = exception.getError();
    
    client.emit('error', {
      status: 'error',
      code: error.error,
      message: error.message,
      timestamp: Date.now(),
    });
  }
}
```

#### Detailed Error Response

```typescript
@Catch(WsException)
export class DetailedErrorFilter implements ExceptionFilter {
  catch(exception: WsException, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const data = host.switchToWs().getData();
    const error = exception.getError();
    
    client.emit('error', {
      status: 'error',
      error: {
        code: error.error || 'UNKNOWN',
        message: error.message,
        details: typeof error.message === 'object' ? error.message : undefined,
      },
      request: {
        event: data?.event,
        timestamp: Date.now(),
      },
      client: {
        id: client.id,
      },
    });
  }
}
```

#### Logging Error Filter

```typescript
@Injectable()
@Catch()
export class LoggingErrorFilter implements ExceptionFilter {
  constructor(private logger: LoggerService) {}
  
  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    const data = host.switchToWs().getData();
    
    // Log the error
    this.logger.error({
      message: exception instanceof Error ? exception.message : 'Unknown error',
      clientId: client.id,
      event: data?.event,
      stack: exception instanceof Error ? exception.stack : undefined,
    });
    
    // Send error to client
    const message = exception instanceof WsException
      ? exception.getError().message
      : 'Internal server error';
    
    client.emit('error', {
      message,
      timestamp: Date.now(),
    });
  }
}
```

### Error Handling Best Practices

1. **Use specific error codes** for different error types:

```typescript
// Good
throw new WsException('User not found', 'USER_NOT_FOUND');
throw new WsException('Invalid credentials', 'AUTH_FAILED');
throw new WsException('Rate limit exceeded', 'RATE_LIMIT');

// Avoid
throw new WsException('Error');
```

2. **Provide helpful error messages**:

```typescript
// Good
throw new WsException('Message length must be between 1 and 1000 characters', 'INVALID_LENGTH');

// Avoid
throw new WsException('Invalid');
```

3. **Use structured error objects** for complex errors:

```typescript
throw new WsException({
  field: 'email',
  message: 'Email format is invalid',
  example: 'user@example.com',
}, 'VALIDATION_ERROR');
```

4. **Handle errors at appropriate levels**:

```typescript
// Class-level filter for all handlers
@UseFilters(GlobalErrorFilter)
@WebSocketGateway()
export class Gateway {
  // Method-level filter for specific handler
  @UseFilters(SpecificErrorFilter)
  @SubscribeMessage('action')
  handleAction() { }
}
```

---

## Lifecycle Hooks

Gateway lifecycle hooks allow you to execute code at specific points in the gateway lifecycle.

### Available Hooks

#### afterInit()

Called after the gateway is initialized and registered with the adapter.

```typescript
import { OnGatewayInit } from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway implements OnGatewayInit {
  afterInit(server: any) {
    console.log('Gateway initialized');
    // Perform initialization tasks
    // - Load initial data
    // - Set up timers
    // - Configure gateway state
  }
}
```

**Use cases:**
- Initialize gateway state
- Load configuration or data
- Set up periodic tasks
- Log gateway startup

**Example:**

```typescript
@WebSocketGateway()
export class GameGateway implements OnGatewayInit {
  private games = new Map();
  
  afterInit(server: any) {
    console.log('Game gateway initialized');
    
    // Load active games from database
    this.loadActiveGames();
    
    // Start cleanup timer
    setInterval(() => {
      this.cleanupInactiveGames();
    }, 60000); // Every minute
  }
  
  private async loadActiveGames() {
    const games = await this.gameService.findActive();
    games.forEach(game => {
      this.games.set(game.id, game);
    });
    console.log(`Loaded ${games.length} active games`);
  }
  
  private cleanupInactiveGames() {
    // Cleanup logic
  }
}
```

#### handleConnection()

Called when a client connects to the gateway.

```typescript
import { OnGatewayConnection } from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway implements OnGatewayConnection {
  handleConnection(client: any) {
    console.log(`Client connected: ${client.id}`);
    // Handle new connection
    // - Authenticate client
    // - Send welcome message
    // - Join default rooms
    // - Track connection
  }
}
```

**Use cases:**
- Authenticate connections
- Send welcome messages
- Auto-join default rooms
- Track active connections
- Log connection events

**Example:**

```typescript
@WebSocketGateway()
export class ChatGateway implements OnGatewayConnection {
  private connectedUsers = new Map();
  
  handleConnection(client: UwsSocket) {
    console.log(`Client connected: ${client.id}`);
    
    // Send welcome message
    client.emit('welcome', {
      message: 'Welcome to the chat!',
      serverId: 'server-1',
      timestamp: Date.now(),
    });
    
    // Auto-join lobby
    client.join('lobby');
    
    // Track connection
    this.connectedUsers.set(client.id, {
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    });
    
    // Notify others
    client.to('lobby').emit('user-connected', {
      userId: client.id,
      count: this.connectedUsers.size,
    });
  }
}
```

#### handleDisconnect()

Called when a client disconnects from the gateway.

```typescript
import { OnGatewayDisconnect } from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway implements OnGatewayDisconnect {
  handleDisconnect(client: any) {
    console.log(`Client disconnected: ${client.id}`);
    // Handle disconnection
    // - Clean up client data
    // - Remove from rooms (automatic)
    // - Notify other clients
    // - Save session data
  }
}
```

**Use cases:**
- Clean up client-specific data
- Notify other clients
- Save session data
- Update presence status
- Log disconnection events

**Example:**

```typescript
@WebSocketGateway()
export class GameGateway implements OnGatewayDisconnect {
  handleDisconnect(client: UwsSocket) {
    console.log(`Client disconnected: ${client.id}`);
    
    // Get user data before cleanup
    const gameId = client.data?.gameId;
    const username = client.data?.user?.name;
    
    // Notify game room if user was in a game
    if (gameId) {
      client.to(`game:${gameId}`).emit('player-disconnected', {
        playerId: client.id,
        username,
      });
      
      // Handle game state
      this.handlePlayerLeave(gameId, client.id);
    }
    
    // Clean up tracking
    this.connectedUsers.delete(client.id);
    
    // Save session data
    if (client.data?.user) {
      this.saveUserSession(client.data.user.id, {
        disconnectedAt: Date.now(),
        lastGameId: gameId,
      });
    }
  }
}
```

### Implementing Multiple Hooks

You can implement multiple lifecycle hooks in a single gateway:

```typescript
import {
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private activeUsers = new Map();
  
  afterInit(server: any) {
    console.log('Chat gateway initialized');
    this.loadConfiguration();
  }
  
  handleConnection(client: UwsSocket) {
    console.log(`User connected: ${client.id}`);
    
    // Initialize user data
    this.activeUsers.set(client.id, {
      connectedAt: Date.now(),
      messageCount: 0,
    });
    
    // Send initial state
    client.emit('init', {
      userId: client.id,
      activeUsers: this.activeUsers.size,
    });
  }
  
  handleDisconnect(client: UwsSocket) {
    console.log(`User disconnected: ${client.id}`);
    
    // Cleanup
    this.activeUsers.delete(client.id);
    
    // Broadcast updated count
    client.broadcast.emit('user-count', {
      count: this.activeUsers.size,
    });
  }
  
  private loadConfiguration() {
    // Load config
  }
}
```

### Lifecycle Hook Patterns

#### Authentication on Connection

```typescript
@WebSocketGateway()
export class SecureGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private authService: AuthService) {}
  
  async handleConnection(client: UwsSocket) {
    try {
      // Extract token from connection (implementation depends on client)
      const token = this.extractToken(client);
      
      if (!token) {
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }
      
      // Validate token
      const user = await this.authService.validateToken(token);
      
      if (!user) {
        client.emit('error', { message: 'Invalid token' });
        client.disconnect();
        return;
      }
      
      // Store user data
      client.data = { user, authenticated: true };
      
      // Send success
      client.emit('authenticated', { user: user.username });
      
    } catch (error) {
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }
  
  handleDisconnect(client: UwsSocket) {
    if (client.data?.user) {
      console.log(`User ${client.data.user.username} disconnected`);
    }
  }
  
  private extractToken(client: UwsSocket): string | null {
    // Extract token from client (implementation specific)
    return null;
  }
}
```

#### Presence Tracking

```typescript
@WebSocketGateway()
export class PresenceGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private presence = new Map<string, { userId: string; status: string }>();
  
  handleConnection(client: UwsSocket) {
    const userId = client.data?.user?.id;
    if (!userId) return;
    
    // Update presence
    this.presence.set(client.id, {
      userId,
      status: 'online',
    });
    
    // Broadcast presence update
    client.broadcast.emit('presence-update', {
      userId,
      status: 'online',
    });
  }
  
  handleDisconnect(client: UwsSocket) {
    const presence = this.presence.get(client.id);
    if (!presence) return;
    
    // Remove presence
    this.presence.delete(client.id);
    
    // Broadcast offline status
    client.broadcast.emit('presence-update', {
      userId: presence.userId,
      status: 'offline',
    });
  }
}
```

#### Session Management

```typescript
@WebSocketGateway()
export class SessionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(private sessionService: SessionService) {}
  
  async handleConnection(client: UwsSocket) {
    const userId = client.data?.user?.id;
    if (!userId) return;
    
    // Load or create session
    const session = await this.sessionService.getOrCreate(userId);
    client.data.session = session;
    
    // Send session data
    client.emit('session', session);
  }
  
  async handleDisconnect(client: UwsSocket) {
    const session = client.data?.session;
    if (!session) return;
    
    // Update session with disconnect time
    await this.sessionService.update(session.id, {
      lastDisconnect: Date.now(),
      duration: Date.now() - session.connectedAt,
    });
  }
}
```

### Best Practices

1. **Keep hooks lightweight** - Avoid heavy operations that block the event loop:

```typescript
// Good - async operations
async handleConnection(client: UwsSocket) {
  const user = await this.userService.find(client.data.userId);
  client.data.user = user;
}

// Avoid - heavy synchronous operations
handleConnection(client: UwsSocket) {
  // Don't do heavy computation here
  this.processLargeDataset(); // Bad!
}
```

2. **Handle errors gracefully**:

```typescript
handleConnection(client: UwsSocket) {
  try {
    // Connection logic
  } catch (error) {
    console.error('Connection error:', error);
    client.emit('error', { message: 'Connection failed' });
    client.disconnect();
  }
}
```

3. **Clean up resources** in handleDisconnect:

```typescript
handleDisconnect(client: UwsSocket) {
  // Clear timers
  if (client.data.heartbeatTimer) {
    clearInterval(client.data.heartbeatTimer);
  }
  
  // Remove from tracking
  this.activeClients.delete(client.id);
  
  // Clean up any other resources
}
```

4. **Use lifecycle hooks for initialization**, not constructors:

```typescript
// Good
@WebSocketGateway()
export class Gateway implements OnGatewayInit {
  afterInit(server: any) {
    this.initialize(); // Initialize here
  }
}

// Avoid
@WebSocketGateway()
export class Gateway {
  constructor() {
    this.initialize(); // Don't initialize in constructor
  }
}
```

---

## Additional Resources

- [NestJS WebSocket Documentation](https://docs.nestjs.com/websockets/gateways)
- [uWebSockets.js Documentation](https://github.com/uNetworking/uWebSockets.js)
- [GitHub Repository](https://github.com/VikramAditya33/uWestJs)
- [npm Package](https://www.npmjs.com/package/uwestjs)

## Support

For issues, questions, or contributions:

- [GitHub Issues](https://github.com/VikramAditya33/uWestJs/issues)
- [GitHub Discussions](https://github.com/VikramAditya33/uWestJs/discussions)
