# uWestJS Benchmarks

Performance benchmarks comparing uWestJS against Express and Fastify.

## Quick Start

From the project root:

```bash
# Quick benchmark (10s per scenario)
npm run benchmark:quick

# Full benchmark (20s per scenario, saves to results.md)
npm run benchmark

# Test setup
npm run benchmark:test
```

Or from the benchmarks directory:

```bash
# Install dependencies
npm install

# Run quick benchmark (10s per scenario)
npm run benchmark:quick

# Run full benchmark (20s per scenario, saves to results.md)
npm run benchmark

# Test setup
npm test
```

### Advanced Commands

For historical tracking and comparison (typically used by CI/CD):

```bash
# Save current results to history
npm run benchmark:save

# Compare current results with last 5 runs
npm run benchmark:compare
```

These commands are automatically run by the CI/CD pipeline. See [Historical Tracking](#historical-tracking) section for details.

## Requirements

- Node.js 24 or 25
- wrk (HTTP benchmarking tool)
  - Linux: `sudo apt-get install wrk`
  - macOS: `brew install wrk`
  - Windows: Use WSL

## Scenarios

### HTTP Benchmarks

1. **hello-world** - Simple text response
   - Tests raw request/response performance
   - Minimal overhead, pure framework speed

2. **json-response** - JSON serialization
   - Tests JSON serialization performance
   - Includes nested objects and arrays

3. **static-file** - Static file serving (10KB)
   - Tests file serving performance
   - Measures throughput for static assets

4. **mixed-response** - Mixed response types
   - Tests different response types (JSON, text, errors)
   - Includes query parameters and status codes

5. **query-params** - Query string parsing
   - Tests query parameter extraction
   - Multiple parameters with different types

6. **post-json** - POST body parsing
   - Tests JSON body parsing performance
   - Uses Lua script for POST requests
   - Echo back parsed data

7. **headers** - Header access
   - Tests request header reading
   - Multiple header access patterns

8. **route-params** - Path parameters
   - Tests route parameter extraction
   - Nested path parameters (/users/:id/posts/:postId)

## Results

uWestJS consistently outperforms Express and Fastify:

- **1.6x - 2.1x faster** than Express
- **1.6x - 2.0x faster** than Fastify

See [results.md](results.md) for detailed benchmark results.

## Historical Tracking

Benchmark results are automatically saved to `history/` directory with:
- Timestamp and commit hash
- Node.js version and platform
- Results for all scenarios

### Compare with History

```bash
# Compare current results with last 5 runs
npm run benchmark:compare

# Save current results to history
npm run benchmark:save
```

The CI/CD pipeline automatically:
- Saves results to history on main branch
- Compares PR results against baseline
- Flags >10% performance regressions

## Architecture

- `scenarios/` - Benchmark scenarios
- `wrk-scripts/` - Lua scripts for wrk (POST requests, etc.)
- `server.js` - Framework server spawner
- `run.js` - Main benchmark runner
- `test-setup.js` - Quick validation script
- `save-history.js` - Save results to history
- `compare-history.js` - Compare with historical data
- `generate-detailed-report.js` - Generate detailed metrics report

## CI/CD

Benchmarks run automatically on:
- Pull requests (posts results as comment)
- Pushes to main/master
- Manual workflow dispatch

See `.github/workflows/benchmark.yml` for configuration.
