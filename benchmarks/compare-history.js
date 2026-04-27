#!/usr/bin/env node
'use strict';

/**
 * Compare Benchmark History
 *
 * Compares current benchmark results against historical data
 * to detect performance regressions.
 */

const fs = require('fs');
const path = require('path');

const REGRESSION_THRESHOLD = 0.1; // 10% regression threshold

function loadHistory(limit = 5) {
  const historyDir = path.join(__dirname, 'history');

  if (!fs.existsSync(historyDir)) {
    return [];
  }

  const files = fs
    .readdirSync(historyDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const filepath = path.join(historyDir, f);
      const content = fs.readFileSync(filepath, 'utf8');
      const data = JSON.parse(content);
      return { name: f, timestamp: data.timestamp, data };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);

  return files.map((f) => f.data);
}

function parseReqPerSec(str) {
  // Parse "10.32k", "1.23M", or "1234" to a number; return NaN for unrecognized inputs.
  if (typeof str !== 'string') return NaN;
  const match = str.trim().match(/^([0-9.]+)\s*([kMG]?)$/);
  if (!match) return NaN;
  const value = parseFloat(match[1]);
  const multiplier = { '': 1, k: 1e3, M: 1e6, G: 1e9 }[match[2]];
  return value * multiplier;
}

function compareResults(current, history) {
  const comparisons = [];

  for (const currentScenario of current.results) {
    const scenarioName = currentScenario.scenario;

    // Find this scenario in history
    const historicalData = history
      .map((h) => {
        const scenario = h.results.find((r) => r.scenario === scenarioName);
        return scenario
          ? {
              date: h.date,
              commit: h.commit,
              reqPerSec: parseReqPerSec(scenario.uwestjs.reqPerSec),
            }
          : null;
      })
      .filter(Boolean);

    if (historicalData.length === 0) {
      comparisons.push({
        scenario: scenarioName,
        status: 'new',
        message: 'New scenario (no historical data)',
      });
      continue;
    }

    // Calculate average of historical data
    const avgHistorical =
      historicalData.reduce((sum, d) => sum + d.reqPerSec, 0) / historicalData.length;
    const currentReqPerSec = parseReqPerSec(currentScenario.uwestjs.reqPerSec);

    // Validate parsed values before comparison
    if (
      !Number.isFinite(currentReqPerSec) ||
      !Number.isFinite(avgHistorical) ||
      avgHistorical === 0
    ) {
      comparisons.push({
        scenario: scenarioName,
        status: 'invalid',
        message: `Invalid data: current=${currentScenario.uwestjs.reqPerSec}, avg=${avgHistorical}`,
        current: currentReqPerSec,
        average: avgHistorical,
        historicalCount: historicalData.length,
      });
      continue;
    }

    const change = (currentReqPerSec - avgHistorical) / avgHistorical;
    const changePercent = (change * 100).toFixed(2);

    let status = 'stable';
    let message = `${changePercent > 0 ? '+' : ''}${changePercent}% vs avg of last ${historicalData.length} runs`;

    if (change < -REGRESSION_THRESHOLD) {
      status = 'regression';
      message = `REGRESSION: ${changePercent}% slower than average`;
    } else if (change > REGRESSION_THRESHOLD) {
      status = 'improvement';
      message = `IMPROVEMENT: ${changePercent}% faster than average`;
    }

    comparisons.push({
      scenario: scenarioName,
      status,
      message,
      current: currentReqPerSec,
      average: avgHistorical,
      change: changePercent,
      historicalCount: historicalData.length,
    });
  }

  return comparisons;
}

function printComparison(comparisons) {
  console.log('\nPerformance Comparison\n');

  let hasRegression = false;

  for (const comp of comparisons) {
    const icon =
      comp.status === 'regression'
        ? '[!]'
        : comp.status === 'improvement'
          ? '[+]'
          : comp.status === 'new'
            ? '[NEW]'
            : '[-]';

    console.log(`${icon} ${comp.scenario}`);
    console.log(`   ${comp.message}`);

    if (comp.status === 'regression' || comp.status === 'invalid') {
      hasRegression = true;
      if (Number.isFinite(comp.current) && Number.isFinite(comp.average)) {
        console.log(`   Current: ${comp.current.toFixed(0)} req/s`);
        console.log(`   Average: ${comp.average.toFixed(0)} req/s`);
      }
    }
    console.log('');
  }

  return hasRegression;
}

function main() {
  const args = process.argv.slice(2);
  const currentPath = args[0] || path.join(__dirname, 'results.md');
  const historyLimit = parseInt(args[1] || '5', 10);

  // Load current results
  if (!fs.existsSync(currentPath)) {
    console.error(`Current results not found: ${currentPath}`);
    process.exit(1);
  }

  const { parseResultsMarkdown } = require('./save-history');
  const markdown = fs.readFileSync(currentPath, 'utf8');
  const results = parseResultsMarkdown(markdown);

  const current = {
    results,
    timestamp: new Date().toISOString(),
  };

  // Load history
  const history = loadHistory(historyLimit);

  if (history.length === 0) {
    console.log('No historical data found. This will be the baseline.');
    process.exit(0);
  }

  console.log(`Comparing against ${history.length} historical runs...`);

  // Compare
  const comparisons = compareResults(current, history);
  const hasRegression = printComparison(comparisons);

  if (hasRegression) {
    console.error('[X] Performance regression detected!');
    process.exit(1);
  } else {
    console.log('[OK] No performance regressions detected');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { compareResults, loadHistory };
