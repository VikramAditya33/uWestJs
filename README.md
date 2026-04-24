<p align="center">
  <img src="assets/uWestJS.png" alt="uWestJS Logo" width="400"/>
</p>

# uWestJS

> High-performance WebSocket adapter for NestJS using uWebSockets.js

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024%20%7C%2025-brightgreen)](https://nodejs.org)
[![CodeFactor](https://www.codefactor.io/repository/github/vikramaditya33/uwestjs/badge)](https://www.codefactor.io/repository/github/vikramaditya33/uwestjs)

uWestJS is a drop-in replacement for the default NestJS WebSocket adapter, powered by [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js). It provides significantly better performance while maintaining full compatibility with NestJS decorators and patterns you already know.

## Why uWestJS?

uWebSockets.js is one of the fastest WebSocket implementations available, offering:

- **10x faster** than traditional WebSocket libraries
- **Lower memory footprint** for handling thousands of concurrent connections
- **Native backpressure handling** to prevent memory issues under load
- **Built-in compression** support for reduced bandwidth usage

uWestJS brings this performance to NestJS without requiring you to change your existing gateway code.

## Features

- Full compatibility with NestJS WebSocket decorators (`@SubscribeMessage`, `@MessageBody`, `@ConnectedSocket`)
- Support for all NestJS middleware: Guards, Pipes, Filters, and Interceptors
- Room-based broadcasting for efficient message distribution
- Built-in CORS configuration
- Automatic message queuing with backpressure handling
- TypeScript support with full type definitions
- Comprehensive test coverage

## Installation

```bash
npm install uwestjs
```

Or using yarn:

```bash
yarn add uwestjs
```

Or using pnpm:

```bash
pnpm add uwestjs
```

## Requirements

- Node.js 20, 22, 24, or 25
- NestJS >= 11.0.0
- TypeScript >= 6.0.0

### Note
- Supported Node.js versions: 20, 22, 24, 25
- If you experience installation or runtime issues, run `npm cache clean --force` before installing


## Quick Start

### Basic Setup

Replace your existing WebSocket adapter with uWestJS in your `main.ts`:

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsAdapter } from 'uwestjs';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Use uWestJS adapter
  app.useWebSocketAdapter(new UwsAdapter(app));
  
  await app.listen(3000);
}
bootstrap();
```

### Create a Gateway

Your existing NestJS gateways work without modification:

```typescript
import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';

@WebSocketGateway()
export class ChatGateway {
  @SubscribeMessage('message')
  handleMessage(
    @MessageBody() data: string,
    @ConnectedSocket() client: any,
  ) {
    return { event: 'response', data: `Echo: ${data}` };
  }

  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() room: string,
    @ConnectedSocket() client: any,
  ) {
    client.join(room);
    return { event: 'joined', data: room };
  }

  @SubscribeMessage('broadcast')
  handleBroadcast(
    @MessageBody() payload: { room: string; message: string },
    @ConnectedSocket() client: any,
  ) {
    client.to(payload.room).emit('message', payload.message);
    return { event: 'broadcasted' };
  }
}
```

### Register the Gateway

After creating your adapter, register your gateway:

```typescript
import { NestFactory } from '@nestjs/core';
import { UwsAdapter } from 'uwestjs';
import { AppModule } from './app.module';
import { ChatGateway } from './chat.gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const adapter = new UwsAdapter(app, { port: 8099 });
  app.useWebSocketAdapter(adapter);
  
  // Register your gateway
  const chatGateway = app.get(ChatGateway);
  adapter.registerGateway(chatGateway);
  
  await app.listen(3000);
}
bootstrap();
```

## Configuration

### Adapter Options

Configure the adapter with various options:

```typescript
import { UwsAdapter } from 'uwestjs';
import * as uWS from 'uWebSockets.js';

const adapter = new UwsAdapter(app, {
  // WebSocket server port
  port: 8099,
  
  // Maximum message size (in bytes)
  maxPayloadLength: 16384, // 16KB
  
  // Idle timeout (in seconds)
  idleTimeout: 60,
  
  // WebSocket endpoint path
  path: '/ws',
  
  // Compression settings
  compression: uWS.SHARED_COMPRESSOR,
  
  // CORS configuration
  cors: {
    origin: 'https://example.com', // Specific origin for security
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});
```

### CORS Configuration

Control cross-origin access to your WebSocket server:

```typescript
// Specific origin (recommended for production)
cors: {
  origin: 'https://example.com',
}

// Allow all origins (use only for development/testing)
cors: { origin: '*' }

// Allow multiple origins
cors: {
  origin: ['https://example.com', 'https://app.example.com'],
}

// Dynamic origin validation (recommended for flexible security)
cors: {
  origin: (origin) => {
    return origin?.endsWith('.example.com') ?? false;
  },
  credentials: true,
}
```

**Security Note:** Never use `origin: '*'` with `credentials: true` in production. This combination is a security risk as it allows any origin to make authenticated requests. Always specify exact origins or use a validation function.

### Dependency Injection Support

Enable dependency injection for guards, pipes, and filters:

```typescript
import { ModuleRef } from '@nestjs/core';

const app = await NestFactory.create(AppModule);
const moduleRef = app.get(ModuleRef);

const adapter = new UwsAdapter(app, {
  port: 8099,
  moduleRef, // Enable DI support
});
```

This allows your guards, pipes, and filters to inject services:

```typescript
import { Injectable, CanActivate } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class WsAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}
  
  canActivate(context: any): boolean {
    try {
      const data = context.switchToWs().getData();
      const token = data?.token;
      if (!token) return false;
      
      const payload = this.jwtService.verify(token);
      const client = context.switchToWs().getClient();
      client.data = { user: payload, authenticated: true };
      return true;
    } catch {
      return false;
    }
  }
}
}
```

## Usage Examples

### Using Guards

Protect your WebSocket handlers with guards:

```typescript
import { UseGuards } from '@nestjs/common';
import { SubscribeMessage, MessageBody } from '@nestjs/websockets';

@WebSocketGateway()
export class SecureGateway {
  @UseGuards(WsAuthGuard)
  @SubscribeMessage('secure-action')
  handleSecureAction(@MessageBody() data: any) {
    return { event: 'success', data };
  }
}
```

### Using Pipes

Transform and validate incoming data:

```typescript
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { SubscribeMessage, MessageBody } from '@nestjs/websockets';
import { IsString, IsNotEmpty } from 'class-validator';

class MessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;
}

@WebSocketGateway()
export class ChatGateway {
  @UsePipes(new ValidationPipe())
  @SubscribeMessage('message')
  handleMessage(@MessageBody() dto: MessageDto) {
    return { event: 'message', data: dto.content };
  }
}
```

### Using Filters

Handle exceptions gracefully:

```typescript
import { Catch, ArgumentsHost } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';

@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const client = host.switchToWs().getClient();
    client.emit('error', {
      message: exception.message,
    });
  }
}

@UseFilters(WsExceptionFilter)
@WebSocketGateway()
export class ChatGateway {
  // Your handlers
}
```

### Room Management

Organize clients into rooms for targeted broadcasting:

```typescript
@WebSocketGateway()
export class GameGateway {
  @SubscribeMessage('join-game')
  handleJoinGame(
    @MessageBody() gameId: string,
    @ConnectedSocket() client: any,
  ) {
    client.join(`game:${gameId}`);
    
    // Notify others in the room
    client.to(`game:${gameId}`).emit('player-joined', {
      playerId: client.id,
    });
    
    return { event: 'joined', gameId };
  }

  @SubscribeMessage('game-action')
  handleGameAction(
    @MessageBody() payload: { gameId: string; action: any },
    @ConnectedSocket() client: any,
  ) {
    // Broadcast to all clients in the game room
    client.to(`game:${payload.gameId}`).emit('game-update', payload.action);
  }

  @SubscribeMessage('leave-game')
  handleLeaveGame(
    @MessageBody() gameId: string,
    @ConnectedSocket() client: any,
  ) {
    client.leave(`game:${gameId}`);
    client.to(`game:${gameId}`).emit('player-left', {
      playerId: client.id,
    });
  }
}
```

### Broadcasting

Send messages to multiple clients efficiently:

```typescript
@WebSocketGateway()
export class NotificationGateway {
  @SubscribeMessage('notify-all')
  notifyAll(@MessageBody() message: string, @ConnectedSocket() client: any) {
    // Broadcast to all connected clients
    client.broadcast.emit('notification', message);
  }

  @SubscribeMessage('notify-room')
  notifyRoom(
    @MessageBody() payload: { room: string; message: string },
    @ConnectedSocket() client: any,
  ) {
    // Broadcast to specific room
    client.to(payload.room).emit('notification', payload.message);
  }

  @SubscribeMessage('notify-rooms')
  notifyMultipleRooms(
    @MessageBody() payload: { rooms: string[]; message: string },
    @ConnectedSocket() client: any,
  ) {
    // Broadcast to multiple rooms
    client.to(payload.rooms).emit('notification', payload.message);
  }
}
```

## Client Connection

Connect to your WebSocket server from the client:

```typescript
// Using native WebSocket
const ws = new WebSocket('ws://localhost:8099');

ws.onopen = () => {
  ws.send(JSON.stringify({
    event: 'message',
    data: 'Hello server!',
  }));
};

ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  console.log('Received:', response);
};
```

```javascript
// Using Socket.IO client (compatible)
import { io } from 'socket.io-client';

const socket = io('ws://localhost:8099');

socket.on('connect', () => {
  socket.emit('message', 'Hello server!');
});

socket.on('response', (data) => {
  console.log('Received:', data);
});
```

## Performance Tips

1. **Use rooms for targeted broadcasting** instead of iterating through clients manually
2. **Enable compression** for large messages to reduce bandwidth
3. **Set appropriate `maxPayloadLength`** based on your message sizes
4. **Use `idleTimeout`** to automatically disconnect inactive clients
5. **Leverage backpressure handling** - the adapter automatically queues messages when clients are slow

## API Reference

### UwsAdapter

The main adapter class that integrates uWebSockets.js with NestJS.

#### Constructor

```typescript
constructor(app: INestApplicationContext, options?: UwsAdapterOptions)
```

#### Methods

- `registerGateway(gateway: object): void` - Register a WebSocket gateway
- `create(port: number, options?: any): any` - Create the WebSocket server
- `bindClientConnect(server: any, callback: Function): void` - Bind connection handler
- `bindClientDisconnect(client: any, callback: Function): void` - Bind disconnection handler
- `bindMessageHandlers(client: any, handlers: MessageMappingProperties[], transform: (data: any) => Observable<any>): void` - Bind message handlers
- `close(server: any): void` - Close the WebSocket server

### Socket Methods

Methods available on the `@ConnectedSocket()` parameter:

- `send(data: string | Buffer): boolean` - Send data to the client
- `emit(event: string, data: any): boolean` - Send an event with data
- `join(room: string | string[]): void` - Join one or more rooms
- `leave(room: string | string[]): void` - Leave one or more rooms
- `to(room: string | string[]): BroadcastOperator` - Target specific rooms for broadcasting
- `broadcast: BroadcastOperator` - Access broadcast operations
- `close(): void` - Close the connection

### BroadcastOperator

Returned by `client.to()` and `client.broadcast` for broadcasting operations:

- `emit(event: string, data: any): void` - Broadcast an event to targeted clients
- `to(room: string | string[]): BroadcastOperator` - Add more rooms to target
- `except(room: string | string[]): BroadcastOperator` - Exclude specific rooms

## Migration Guide

### From Socket.IO Adapter

If you're migrating from the default Socket.IO adapter:

1. Install uWestJS: `npm install uwestjs`
2. Replace the adapter in `main.ts`:

```typescript
// Before
import { IoAdapter } from '@nestjs/platform-socket.io';
app.useWebSocketAdapter(new IoAdapter(app));

// After
import { UwsAdapter } from 'uwestjs';
const adapter = new UwsAdapter(app, { port: 8099 });
app.useWebSocketAdapter(adapter);
```

3. Register your gateways:

```typescript
const gateway = app.get(YourGateway);
adapter.registerGateway(gateway);
```

4. Update client connections to use the new port (default: 8099)

Your gateway code remains unchanged - all decorators work the same way.

## Troubleshooting

### Connection Issues

If clients can't connect:

- Verify the port is not blocked by a firewall
- Check that the WebSocket path matches between client and server
- Ensure CORS is configured correctly for your origin

### Message Not Received

If messages aren't being received:

- Verify the event name matches between client and server
- Check that the message format is valid JSON
- Ensure the gateway is properly registered with `adapter.registerGateway()`

### Performance Issues

If you experience performance problems:

- Increase `maxPayloadLength` if you're sending large messages
- Enable compression for bandwidth-intensive applications
- Use rooms for targeted broadcasting instead of iterating clients
- Monitor backpressure - slow clients are automatically handled

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run tests with coverage
npm run test:cov

# Run tests in watch mode
npm run test:watch
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on top of [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)
- Designed for [NestJS](https://nestjs.com/)
- Inspired by the NestJS community's need for high-performance WebSocket solutions

## Support

- GitHub Issues: [Report a bug](https://github.com/VikramAditya33/uWestJs/issues)
- GitHub Discussions: [Ask questions](https://github.com/VikramAditya33/uWestJs/discussions)

## Author

Vikram Aditya

## Links

- [GitHub Repository](https://github.com/VikramAditya33/uWestJs)
- [npm Package](https://www.npmjs.com/package/uwestjs)
- [NestJS Documentation](https://docs.nestjs.com/websockets/gateways)
- [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)
