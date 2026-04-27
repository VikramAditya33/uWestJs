#!/usr/bin/env node
'use strict';

// Quick test to verify benchmark setup works

const http = require('http');
const path = require('path');

async function testFramework(framework, port) {
  console.log(`\nTesting ${framework}...`);

  let frameworkModule;
  let app;
  let server;
  let adapter;

  // Load framework
  if (framework === 'express') {
    frameworkModule = require('express');
    app = frameworkModule();
  } else if (framework === 'fastify') {
    frameworkModule = require('fastify');
    app = frameworkModule({ logger: false });
  } else if (framework === 'uwestjs') {
    const { UwsPlatformAdapter } = require('../dist/http/platform/uws-platform.adapter');
    adapter = new UwsPlatformAdapter({
      maxBodySize: 10 * 1024 * 1024,
      etag: false,
      bodyParser: {
        json: true,
        urlencoded: true,
      },
    });
    app = adapter; // Use adapter as app
  }

  // Load scenario
  const scenario = require(path.join(__dirname, 'scenarios', 'hello-world.js'));
  await scenario.setup(app, framework);

  // Start server
  if (framework === 'fastify') {
    await app.listen({ port, host: '127.0.0.1' });
  } else if (framework === 'uwestjs') {
    await new Promise((resolve, reject) => {
      adapter.listen(port, '127.0.0.1', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else {
    server = await new Promise((resolve, reject) => {
      const s = app.listen(port, '127.0.0.1');
      s.once('listening', () => resolve(s));
      s.once('error', reject);
    });
  }

  console.log(`  Server started on port ${port}`);

  // Test request
  const result = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });

  console.log(`  Response: ${result.status} - ${result.body}`);

  // Stop server
  if (framework === 'fastify') {
    await app.close();
  } else if (framework === 'uwestjs') {
    await adapter.close();
  } else if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`  [OK] ${framework} works!`);
}

async function main() {
  console.log('Testing benchmark setup...\n');

  try {
    await testFramework('express', 3001);
    await testFramework('fastify', 3002);
    await testFramework('uwestjs', 3003);

    console.log('\n[OK] All frameworks working!');
    console.log('\nNext steps:');
    console.log('  1. Run benchmarks: npm run benchmark:quick');
  } catch (error) {
    console.error('\n[X] Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
