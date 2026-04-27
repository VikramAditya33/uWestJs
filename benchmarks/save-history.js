#!/usr/bin/env node
'use strict';

/**
 * Save Benchmark History
 *
 * Saves benchmark results to history directory with timestamp and commit hash.
 * Used by CI/CD to track performance over time.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getCommitMessage() {
  try {
    return execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseResultsMarkdown(markdown) {
  const results = [];
  const lines = markdown.split('\n');

  // Find the table
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('| Scenario |')) {
      inTable = true;
      continue;
    }
    if (line.startsWith('| --- |')) {
      continue;
    }
    if (inTable && line.startsWith('|')) {
      // Strip the leading/trailing pipes only, preserving empty cells.
      const parts = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((s) => s.trim());
      if (parts.length >= 9) {
        results.push({
          scenario: parts[0],
          express: {
            reqPerSec: parts[1],
            throughput: parts[4],
          },
          fastify: {
            reqPerSec: parts[2],
            throughput: parts[5],
          },
          uwestjs: {
            reqPerSec: parts[3],
            throughput: parts[6],
          },
          vsExpress: parts[7],
          vsFastify: parts[8],
        });
      }
    }
    if (inTable && !line.startsWith('|')) {
      break;
    }
  }

  return results;
}

function saveHistory(resultsPath) {
  const historyDir = path.join(__dirname, 'history');

  // Ensure history directory exists
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  // Read results
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Results file not found: ${resultsPath}`);
  }

  const markdown = fs.readFileSync(resultsPath, 'utf8');
  const results = parseResultsMarkdown(markdown);

  if (results.length === 0) {
    throw new Error('No results found in markdown file');
  }

  // Create history entry
  const entry = {
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
    commit: getCommitHash(),
    commitMessage: getCommitMessage(),
    branch: getBranch(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    results,
  };

  // Save to history
  const safeTimestamp = entry.timestamp.replace(/[:.]/g, '-');
  const filename = `${safeTimestamp}-${entry.commit}.json`;
  const filepath = path.join(historyDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf8');
  console.log(`[OK] Saved benchmark history: ${filename}`);

  return entry;
}

function main() {
  const args = process.argv.slice(2);
  const resultsPath = args[0] || path.join(__dirname, 'results.md');

  try {
    const entry = saveHistory(resultsPath);
    console.log(`\nCommit: ${entry.commit}`);
    console.log(`Branch: ${entry.branch}`);
    console.log(`Node: ${entry.nodeVersion}`);
    console.log(`Scenarios: ${entry.results.length}`);
  } catch (error) {
    console.error('Failed to save history:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { saveHistory, parseResultsMarkdown };
