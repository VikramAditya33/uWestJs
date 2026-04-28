# WebSocket Middleware

uWestJS supports all NestJS middleware: Guards, Pipes, and Filters.

## Table of Contents

- [Overview](#overview)
- [Guards](#guards)
- [Pipes](#pipes)
- [Filters](#filters)
- [Combining Middleware](#combining-middleware)
- [Execution Order](#execution-order)

---

## Overview

Middleware in uWestJS provides:

- **Guards** - Determine whether a request should be handled
- **Pipes** - Transform and validate incoming data
- **Filters** - Handle errors thrown during message handling

**Dependency Injection:** To use DI in middleware, provide `moduleRef` to the adapter.

---

## Guards

Guards determine whether a request should be handled by the route handler.

### Creating a Guard

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

### Using Guards

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

### Guard with Dependency Injection

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
import { ModuleRef } from '@nestjs/core';

const moduleRef = app.get(ModuleRef);
const adapter = new UwsAdapter(app, { 
  port: 8099, 
  moduleRef // Auto-wrapped internally
});
```

### Async Guards

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

### Guard Examples

```typescript
// Role-based guard
@Injectable()
export class WsRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient();
    const requiredRole = 'admin';
    
    return client.data?.user?.role === requiredRole;
  }
}

// Rate limiting guard with automatic cleanup
// IMPORTANT: This uses in-memory storage and won't work across multiple server instances
// For production with multiple instances, use @nestjs/throttler with Redis
@Injectable()
export class WsRateLimitGuard implements CanActivate, OnModuleDestroy {
  private requests = new Map<string, number[]>();
  private readonly limit = 10;
  private readonly window = 60000; // 1 minute
  private cleanupInterval?: NodeJS.Timeout;
  
  constructor() {
    // Clean up old entries periodically to prevent memory leak
    this.cleanupInterval = setInterval(() => this.cleanup(), this.window);
  }
  
  onModuleDestroy() {
    // Clean up interval timer when module is destroyed
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }
  
  private cleanup() {
    const now = Date.now();
    for (const [clientId, timestamps] of this.requests.entries()) {
      // Filter out old timestamps beyond the time window
      const recent = timestamps.filter(time => now - time < this.window);
      if (recent.length === 0) {
        // Remove entry if no recent requests
        this.requests.delete(clientId);
      } else {
        // Update with filtered timestamps
        this.requests.set(clientId, recent);
      }
    }
  }
  
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient();
    const now = Date.now();
    
    const requests = this.requests.get(client.id) || [];
    const recentRequests = requests.filter(time => now - time < this.window);
    
    if (recentRequests.length >= this.limit) {
      return false;
    }
    
    recentRequests.push(now);
    this.requests.set(client.id, recentRequests);
    return true;
  }
  
  // Optional: Clean up client data when they disconnect
  handleDisconnect(client: any) {
    this.requests.delete(client.id);
  }
}

// Usage: Wire up the handleDisconnect method in your gateway
import { WebSocketGateway, OnGatewayDisconnect } from '@nestjs/websockets';
import { UwsSocket } from 'uwestjs';

@WebSocketGateway()
export class ExampleGateway implements OnGatewayDisconnect {
  constructor(private rateLimitGuard: WsRateLimitGuard) {}
  
  handleDisconnect(client: UwsSocket) {
    // Call the guard's cleanup method
    this.rateLimitGuard.handleDisconnect(client);
  }
}

// For production with multiple server instances, use @nestjs/throttler with Redis:
// npm install @nestjs/throttler @nestjs/throttler-storage-redis
//
// import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
// import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';
//
// @Module({
//   imports: [
//     ThrottlerModule.forRoot({
//       ttl: 60,
//       limit: 10,
//       storage: new ThrottlerStorageRedisService(redisClient), // Shared across instances
//     }),
//   ],
// })
// export class AppModule {}
```

---

## Pipes

Pipes transform and validate incoming data.

### Creating a Pipe

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

### Using Pipes

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

### Built-in Pipes

```typescript
import {
  ValidationPipe,
  ParseIntPipe,
  ParseBoolPipe,
  ParseArrayPipe,
  UsePipes,
} from '@nestjs/common';
import { IsInt, IsBoolean, IsArray } from 'class-validator';

// Recommended: Use DTO with ValidationPipe for type-safe validation
class ExampleDto {
  @IsInt()
  id: number;
  
  @IsBoolean()
  active: boolean;
  
  @IsArray()
  tags: string[];
}

@WebSocketGateway()
export class ExampleGateway {
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage('example')
  handleExample(@MessageBody() dto: ExampleDto) {
    const { id, active, tags } = dto;
    // All fields are validated and transformed by class-validator
  }
}

// Alternative: Extract individual fields with pipes
@WebSocketGateway()
export class FieldExtractionGateway {
  @SubscribeMessage('example')
  handleExample(
    @MessageBody('id', ParseIntPipe) id: number,
    @MessageBody('active', ParseBoolPipe) active: boolean,
    @MessageBody('tags', ParseArrayPipe) tags: string[],
  ) {
    // Each @MessageBody('field') extracts a specific property and applies its pipe
    // id, active, and tags are properly typed and validated
  }
}
```

### Async Pipes

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

### Pipe Examples

```typescript
// Sanitization pipe
@Injectable()
export class SanitizePipe implements PipeTransform {
  transform(value: string): string {
    return value.trim().replace(/<[^>]*>/g, '');
  }
}

// Transformation pipe
@Injectable()
export class ToUpperCasePipe implements PipeTransform {
  transform(value: string): string {
    return value.toUpperCase();
  }
}

// Complex validation pipe
@Injectable()
export class CustomValidationPipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata): Promise<any> {
    if (metadata.type === 'body') {
      // Validate body
      if (!value || typeof value !== 'object') {
        throw new WsException('Invalid body');
      }
    }
    return value;
  }
}
```

---

## Filters

Exception filters handle errors thrown during message handling.

### Creating a Filter

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

### Using Filters

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

### Filter with Dependency Injection

```typescript
import { Injectable, Catch, ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { WsException } from 'uwestjs';

// Example custom logger service - replace with your own logging implementation
// You could also use @nestjs/common Logger or a third-party logger like Winston
interface LoggerService {
  error(message: any): void;
}

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

### Filter Examples

```typescript
// Standard error filter
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

// Detailed error filter
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

// Logging error filter
@Injectable()
@Catch()
export class LoggingErrorFilter implements ExceptionFilter {
  constructor(private logger: LoggerService) {} // Inject your custom logger service
  
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

---

## Combining Middleware

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

---

## Execution Order

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

**Example:**

```typescript
@WebSocketGateway()
export class OrderedGateway {
  @UseGuards(AuthGuard, RoleGuard)
  @UsePipes(ValidationPipe, TransformPipe)
  @UseFilters(WsExceptionFilter)
  @SubscribeMessage('process')
  handleProcess(@MessageBody() data: any) {
    // Execution order:
    // 1. AuthGuard checks authentication
    // 2. RoleGuard checks user role
    // 3. ValidationPipe validates data
    // 4. TransformPipe transforms data
    // 5. Handler executes
    // 6. If any error occurs, WsExceptionFilter catches it
    
    return { event: 'processed', data };
  }
}
```

---

## See Also

- [Adapter](./Adapter.md)
- [Decorators](./Decorators.md)
- [Exceptions](./Exceptions.md)
- [Lifecycle](./Lifecycle.md)
