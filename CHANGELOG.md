# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security

## [1.0.1] - 2026-04-06

### Changed
- Updated uWebSockets.js dependency from v20.48.0 to v20.60.0
- Added Node.js 24 and 25 support
- Updated devDependencies to latest versions
- Include Jest types in tsconfig.json

## [1.0.0] - 2026-04-05

### Added
- Initial stable release of uWestJS
- High-performance WebSocket adapter using uWebSockets.js v20.48.0
- Full NestJS WebSocket decorator support
  - `@WebSocketGateway()` for gateway definition
  - `@SubscribeMessage()` for message handlers
  - `@MessageBody()` / `@Payload()` for message data extraction
  - `@ConnectedSocket()` for socket injection
- Complete middleware support
  - Guards for authentication and authorization
  - Pipes for data transformation and validation
  - Filters for exception handling
  - Dependency injection support via ModuleRef
- Room-based broadcasting with Socket.IO-compatible API
  - `client.join()` and `client.leave()` for room management
  - `client.to()` for room-targeted broadcasting
  - `client.broadcast` for broadcasting to all clients
  - `BroadcastOperator` with chaining support
- Lifecycle hooks support
  - `afterInit()` for gateway initialization
  - `handleConnection()` for client connections
  - `handleDisconnect()` for client disconnections
- Configuration options
  - Configurable port (default: 8099)
  - Maximum payload length configuration
  - Idle timeout configuration
  - Compression options (disabled, shared, dedicated)
  - WebSocket path configuration
  - CORS configuration with flexible origin validation
- Automatic backpressure handling and message queuing
- Manual gateway registration via `registerGateway()`
- Comprehensive test coverage with unit and integration tests
  - Separate test scripts for unit and integration tests
  - Full test suite with high coverage
- Complete documentation
  - Comprehensive README with quick start guide
  - Full API reference documentation
  - Migration guide from Socket.IO adapter
  - Versioning guide for maintainers
  - Performance tips and troubleshooting guide
- TypeScript support with full type definitions
- Support for NestJS 9.x, 10.x, and 11.x
- Node.js >= 20.0.0 requirement

### Technical Details
- Built on uWebSockets.js for maximum performance
- Socket.IO-compatible API for easy migration
- Efficient room management with automatic cleanup
- Native backpressure handling to prevent memory issues
- Metadata scanning for decorator-based routing
- Message router with handler execution pipeline
- Exception handling with WsException class
- Broadcast operator with room targeting and client exclusion

[Unreleased]: https://github.com/FOSSFORGE/uWestJS/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/FOSSFORGE/uWestJS/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/FOSSFORGE/uWestJS/releases/tag/v1.0.0
