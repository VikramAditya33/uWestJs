'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { parseArgs } = require('./lib/cli');
const { formatReqPerSec, formatBytesPerSec } = require('./lib/format');

const SCENARIO_FILES = fs
  .readdirSync(path.join(__dirname, 'scenarios'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => file.replace('.js', ''));

const FRAMEWORKS = [
  { id: 'express', label: 'Express', port: 3001 },
  { id: 'fastify', label: 'Fastify', port: 3002 },
  { id: 'uwestjs', label: 'uWestJS', port: 3000 },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReady(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryReady = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/__ready' }, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for server on port ${port}`));
          return;
        }
        setTimeout(tryReady, 300);
      });

      request.setTimeout(1000, () => request.destroy(new Error('readiness probe socket timeout')));

      request.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for server on port ${port}`));
          return;
        }
        setTimeout(tryReady, 300);
      });
    };

    tryReady();
  });
}

function startScenarioServer(framework, scenarioName) {
  const serverScript = path.join(__dirname, 'server.js');
  const serverArgs = [
    serverScript,
    '--framework',
    framework.id,
    '--scenario',
    scenarioName,
    '--port',
    String(framework.port),
  ];

  const server = spawn(process.execPath, serverArgs, {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return { server, stderrRef: () => stderr };
}

async function stopScenarioServer(server, stderrRef) {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await wait(500);
    if (server.exitCode === null) {
      server.kill('SIGKILL');
    }
  }

  const stderr = stderrRef();
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }

  // Add delay to ensure port is fully released
  await wait(500);
}

function runHttpRequest(port, path, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            bodyHash: crypto.createHash('sha256').update(body).digest('hex'),
            bodySize: body.length,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function validateScenarioResponses(scenarioName, scenario) {
  const results = {};

  for (const framework of FRAMEWORKS) {
    const { server, stderrRef } = startScenarioServer(framework, scenarioName);
    try {
      await waitForReady(framework.port);
      results[framework.id] = await runHttpRequest(framework.port, scenario.path);
    } catch (error) {
      results[framework.id] = { error: error.message };
    } finally {
      await stopScenarioServer(server, stderrRef);
    }
  }

  // Compare results
  const hashes = Object.values(results)
    .map((r) => r.bodyHash)
    .filter(Boolean);
  const allSame = hashes.every((h) => h === hashes[0]);

  if (allSame && hashes.length === FRAMEWORKS.length) {
    return {
      ok: true,
      message: `All frameworks return identical response (sha256: ${hashes[0].slice(0, 12)})`,
    };
  }

  return {
    ok: false,
    message: Object.entries(results)
      .map(
        ([fw, r]) => `${fw}: ${r.error || `hash=${r.bodyHash?.slice(0, 12)}, size=${r.bodySize}`}`
      )
      .join(' | '),
  };
}

function parseRequestsPerSec(output) {
  const totalMatch = output.match(/Requests\/sec:\s+([0-9.]+)/);
  if (totalMatch) {
    return Number(totalMatch[1]);
  }
  return 0;
}

function parseTransferPerSec(output) {
  const match = output.match(/Transfer\/sec:\s+([0-9.]+)([KMG]?B)/);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'KB') return value * 1024;
  if (unit === 'MB') return value * 1024 * 1024;
  if (unit === 'GB') return value * 1024 * 1024 * 1024;
  return value;
}

function parseLatencyStats(output) {
  // Parse latency distribution from wrk output
  // Example: "Latency    10.23ms   12.45ms   15.67ms   89.12%"
  const latencyMatch = output.match(
    /Latency\s+([0-9.]+)(us|ms|s)\s+([0-9.]+)(us|ms|s)\s+([0-9.]+)(us|ms|s)/
  );

  if (!latencyMatch) {
    return null;
  }

  const convertToMs = (value, unit) => {
    const num = parseFloat(value);
    if (unit === 'us') return num / 1000;
    if (unit === 's') return num * 1000;
    return num; // ms
  };

  return {
    avg: convertToMs(latencyMatch[1], latencyMatch[2]),
    stdev: convertToMs(latencyMatch[3], latencyMatch[4]),
    max: convertToMs(latencyMatch[5], latencyMatch[6]),
  };
}

function parseLatencyPercentiles(output) {
  // Parse latency distribution percentiles
  // Example lines:
  //   50.000%    1.23ms
  //   75.000%    2.34ms
  //   90.000%    3.45ms
  //   99.000%    5.67ms
  const percentiles = {};
  const lines = output.split('\n');

  for (const line of lines) {
    const match = line.match(/\s+([0-9.]+)%\s+([0-9.]+)(us|ms|s)/);
    if (match) {
      const percent = parseFloat(match[1]);
      const value = parseFloat(match[2]);
      const unit = match[3];

      let valueMs = value;
      if (unit === 'us') valueMs = value / 1000;
      if (unit === 's') valueMs = value * 1000;

      if (percent === 50) percentiles.p50 = valueMs;
      if (percent === 75) percentiles.p75 = valueMs;
      if (percent === 90) percentiles.p90 = valueMs;
      if (percent === 95) percentiles.p95 = valueMs;
      if (percent === 99) percentiles.p99 = valueMs;
      if (percent === 99.9) percentiles.p999 = valueMs;
    }
  }

  return Object.keys(percentiles).length > 0 ? percentiles : null;
}

function parseErrors(output) {
  const errors = {
    connect: 0,
    read: 0,
    write: 0,
    timeout: 0,
    non2xx: 0,
  };

  // Socket errors: connect 0, read 0, write 0, timeout 0
  const socketMatch = output.match(
    /Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/
  );
  if (socketMatch) {
    errors.connect = parseInt(socketMatch[1], 10);
    errors.read = parseInt(socketMatch[2], 10);
    errors.write = parseInt(socketMatch[3], 10);
    errors.timeout = parseInt(socketMatch[4], 10);
  }

  // Non-2xx or 3xx responses: 123
  const non2xxMatch = output.match(/Non-2xx or 3xx responses:\s+(\d+)/);
  if (non2xxMatch) {
    errors.non2xx = parseInt(non2xxMatch[1], 10);
  }

  const totalErrors = errors.connect + errors.read + errors.write + errors.timeout + errors.non2xx;
  return totalErrors > 0 ? errors : null;
}

async function runScenario(framework, scenarioName, scenario, durationSeconds) {
  const { server, stderrRef } = startScenarioServer(framework, scenarioName);

  try {
    await waitForReady(framework.port);

    const wrk = scenario.wrk || {};
    const args = [
      '--latency',
      '-t',
      String(wrk.threads || 4),
      '-c',
      String(wrk.connections || 200),
      '-d',
      `${durationSeconds}s`,
    ];

    // Add Lua script if specified
    if (wrk.script) {
      args.push('-s', path.join(__dirname, 'wrk-scripts', wrk.script));
    }

    // Add URL (script may override path)
    const targetUrl = wrk.script
      ? `http://127.0.0.1:${framework.port}`
      : `http://127.0.0.1:${framework.port}${scenario.path}`;
    args.push(targetUrl);

    const wrkResult = spawnSync('wrk', args, {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: Math.max(60000, durationSeconds * 1000 + 45000),
      killSignal: 'SIGKILL',
    });

    if (wrkResult.status !== 0) {
      throw new Error(`wrk failed: ${wrkResult.stderr || wrkResult.stdout}`);
    }

    const requestsPerSec = parseRequestsPerSec(wrkResult.stdout);
    const transferPerSecBytes = parseTransferPerSec(wrkResult.stdout);
    const latencyStats = parseLatencyStats(wrkResult.stdout);
    const latencyPercentiles = parseLatencyPercentiles(wrkResult.stdout);
    const errors = parseErrors(wrkResult.stdout);

    if (requestsPerSec === 0) {
      throw new Error(`wrk produced invalid output for ${framework.id}/${scenarioName}`);
    }

    return {
      requestsPerSec,
      transferPerSecBytes,
      latencyStats,
      latencyPercentiles,
      errors,
      raw: wrkResult.stdout,
    };
  } finally {
    await stopScenarioServer(server, stderrRef);
  }
}

function buildMarkdown(results) {
  const lines = [];
  lines.push('<!-- benchmark-results -->');
  lines.push('# uWestJS Benchmark Results');
  lines.push('');
  lines.push(
    '| Scenario | Express req/s | Fastify req/s | uWestJS req/s | Express throughput | Fastify throughput | uWestJS throughput | uWestJS vs Express | uWestJS vs Fastify |'
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const row of results) {
    const express = row.express.ok ? row.express : null;
    const fastify = row.fastify.ok ? row.fastify : null;
    const uwestjs = row.uwestjs.ok ? row.uwestjs : null;

    const expressReq = express ? formatReqPerSec(express.requestsPerSec) : 'FAILED';
    const fastifyReq = fastify ? formatReqPerSec(fastify.requestsPerSec) : 'FAILED';
    const uwestjsReq = uwestjs ? formatReqPerSec(uwestjs.requestsPerSec) : 'FAILED';

    const expressTransfer = express ? formatBytesPerSec(express.transferPerSecBytes) : 'FAILED';
    const fastifyTransfer = fastify ? formatBytesPerSec(fastify.transferPerSecBytes) : 'FAILED';
    const uwestjsTransfer = uwestjs ? formatBytesPerSec(uwestjs.transferPerSecBytes) : 'FAILED';

    const vsExpress =
      express && uwestjs
        ? `${(uwestjs.requestsPerSec / express.requestsPerSec).toFixed(2)}x`
        : 'N/A';
    const vsFastify =
      fastify && uwestjs
        ? `${(uwestjs.requestsPerSec / fastify.requestsPerSec).toFixed(2)}x`
        : 'N/A';

    lines.push(
      `| ${row.name} | ${expressReq} | ${fastifyReq} | ${uwestjsReq} | ${expressTransfer} | ${fastifyTransfer} | ${uwestjsTransfer} | **${vsExpress}** | **${vsFastify}** |`
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const durationSeconds = Number(args.duration || 20);
  const outputPath = args.output ? path.resolve(process.cwd(), args.output) : null;
  const requestedScenario = args.scenario;
  const validate = args.validate === 'true'; // Only validate if explicitly requested
  const scenarioList = requestedScenario ? [requestedScenario] : SCENARIO_FILES;

  console.log(`Running benchmarks for ${scenarioList.length} scenario(s)...`);
  console.log(`Duration: ${durationSeconds}s per scenario\n`);

  const results = [];

  for (const scenarioName of scenarioList) {
    const scenario = require(path.join(__dirname, 'scenarios', `${scenarioName}.js`));
    console.log(`\n=== Scenario: ${scenario.name} ===`);

    // Validate responses only if requested
    if (validate) {
      console.log('Validating responses...');
      const validation = await validateScenarioResponses(scenarioName, scenario);
      console.log(validation.ok ? `[OK] ${validation.message}` : `[X] ${validation.message}`);
    }

    // Run benchmarks
    const scenarioResults = { name: scenario.name };

    for (const framework of FRAMEWORKS) {
      console.log(`Running ${framework.label}...`);
      try {
        const result = await runScenario(framework, scenarioName, scenario, durationSeconds);
        scenarioResults[framework.id] = { ok: true, ...result };
        console.log(
          `  ${formatReqPerSec(result.requestsPerSec)} req/s, ${formatBytesPerSec(result.transferPerSecBytes)}`
        );
      } catch (error) {
        scenarioResults[framework.id] = { ok: false, error: error.message };
        console.error(`  FAILED: ${error.message}`);
      }
    }

    results.push(scenarioResults);
  }

  // Generate markdown
  const markdown = buildMarkdown(results);

  if (outputPath) {
    fs.writeFileSync(outputPath, markdown, 'utf8');
    console.log(`\nResults saved to: ${outputPath}`);

    // Also save JSON for detailed report generation
    const parsed = path.parse(outputPath);
    const jsonPath = path.join(parsed.dir, `${parsed.name}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`JSON results saved to: ${jsonPath}`);
  }

  console.log('\n' + markdown);
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
