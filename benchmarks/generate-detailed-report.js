#!/usr/bin/env node
'use strict';

/**
 * Generate Detailed Benchmark Report
 *
 * Creates an enhanced report with latency percentiles, error rates,
 * and detailed performance metrics.
 */

const fs = require('fs');
const path = require('path');
const { formatLatency, formatReqPerSec, formatBytesPerSec } = require('./lib/format');

function generateSummaryTable(results) {
  const lines = [];
  lines.push('## Performance Summary');
  lines.push('');
  lines.push('| Scenario | Express | Fastify | uWestJS | vs Express | vs Fastify |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');

  for (const row of results) {
    const express = row.express.ok ? row.express : null;
    const fastify = row.fastify.ok ? row.fastify : null;
    const uwestjs = row.uwestjs.ok ? row.uwestjs : null;

    const expressReq = express ? formatReqPerSec(express.requestsPerSec) : 'FAILED';
    const fastifyReq = fastify ? formatReqPerSec(fastify.requestsPerSec) : 'FAILED';
    const uwestjsReq = uwestjs ? formatReqPerSec(uwestjs.requestsPerSec) : 'FAILED';

    const vsExpress =
      express && uwestjs
        ? `**${(uwestjs.requestsPerSec / express.requestsPerSec).toFixed(2)}x**`
        : 'N/A';
    const vsFastify =
      fastify && uwestjs
        ? `**${(uwestjs.requestsPerSec / fastify.requestsPerSec).toFixed(2)}x**`
        : 'N/A';

    lines.push(
      `| ${row.name} | ${expressReq} | ${fastifyReq} | ${uwestjsReq} | ${vsExpress} | ${vsFastify} |`
    );
  }

  lines.push('');
  return lines;
}

function generateThroughputTable(row) {
  const lines = [];
  lines.push('#### Throughput');
  lines.push('');
  lines.push('| Framework | Requests/sec | Transfer/sec |');
  lines.push('| --- | ---: | ---: |');

  for (const [framework, data] of Object.entries(row)) {
    if (framework === 'name') continue;
    if (!data.ok) {
      lines.push(`| ${framework} | FAILED | FAILED |`);
      continue;
    }
    lines.push(
      `| ${framework} | ${formatReqPerSec(data.requestsPerSec)} | ${formatBytesPerSec(data.transferPerSecBytes)} |`
    );
  }

  lines.push('');
  return lines;
}

function generateLatencyTable(row) {
  const lines = [];
  const hasLatency = Object.values(row).some((d) => d.ok && d.latencyStats);

  if (hasLatency) {
    lines.push('#### Latency');
    lines.push('');
    lines.push('| Framework | Avg | StdDev | Max |');
    lines.push('| --- | ---: | ---: | ---: |');

    for (const [framework, data] of Object.entries(row)) {
      if (framework === 'name') continue;
      if (!data.ok || !data.latencyStats) {
        lines.push(`| ${framework} | N/A | N/A | N/A |`);
        continue;
      }
      const stats = data.latencyStats;
      lines.push(
        `| ${framework} | ${formatLatency(stats.avg)} | ${formatLatency(stats.stdev)} | ${formatLatency(stats.max)} |`
      );
    }

    lines.push('');
  }

  return lines;
}

function generatePercentilesTable(row) {
  const lines = [];
  const hasPercentiles = Object.values(row).some((d) => d.ok && d.latencyPercentiles);

  if (hasPercentiles) {
    lines.push('#### Latency Percentiles');
    lines.push('');
    lines.push('| Framework | P50 | P75 | P90 | P95 | P99 | P99.9 |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');

    for (const [framework, data] of Object.entries(row)) {
      if (framework === 'name') continue;
      if (!data.ok || !data.latencyPercentiles) {
        lines.push(`| ${framework} | N/A | N/A | N/A | N/A | N/A | N/A |`);
        continue;
      }
      const p = data.latencyPercentiles;
      lines.push(
        `| ${framework} | ${formatLatency(p.p50)} | ${formatLatency(p.p75)} | ${formatLatency(p.p90)} | ${formatLatency(p.p95)} | ${formatLatency(p.p99)} | ${formatLatency(p.p999)} |`
      );
    }

    lines.push('');
  }

  return lines;
}

function generateErrorsTable(row) {
  const lines = [];
  const hasErrors = Object.values(row).some((d) => d.ok && d.errors);

  if (hasErrors) {
    lines.push('#### Errors');
    lines.push('');
    lines.push('| Framework | Connect | Read | Write | Timeout | Non-2xx |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');

    for (const [framework, data] of Object.entries(row)) {
      if (framework === 'name') continue;
      if (!data.ok) {
        lines.push(`| ${framework} | - | - | - | - | - |`);
        continue;
      }
      if (!data.errors) {
        lines.push(`| ${framework} | 0 | 0 | 0 | 0 | 0 |`);
        continue;
      }
      const e = data.errors;
      lines.push(
        `| ${framework} | ${e.connect} | ${e.read} | ${e.write} | ${e.timeout} | ${e.non2xx} |`
      );
    }

    lines.push('');
  }

  return lines;
}

function generateDetailedReport(results) {
  const lines = [];

  lines.push('# uWestJS Detailed Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Summary table
  lines.push(...generateSummaryTable(results));

  // Detailed metrics for each scenario
  lines.push('## Detailed Metrics');
  lines.push('');

  for (const row of results) {
    lines.push(`### ${row.name}`);
    lines.push('');

    lines.push(...generateThroughputTable(row));
    lines.push(...generateLatencyTable(row));
    lines.push(...generatePercentilesTable(row));
    lines.push(...generateErrorsTable(row));

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0] || path.join(__dirname, 'results.json');
  const outputPath = args[1] || path.join(__dirname, 'detailed-report.md');

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error('Run benchmarks first to generate results.json');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const report = generateDetailedReport(results);

  fs.writeFileSync(outputPath, report, 'utf8');
  console.log(`[OK] Detailed report generated: ${outputPath}`);
  console.log(report);
}

if (require.main === module) {
  main();
}

module.exports = { generateDetailedReport };
