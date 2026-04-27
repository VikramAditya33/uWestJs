'use strict';

const path = require('path');
const { parseArgs } = require('./lib/cli');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const framework = args.framework;
  const scenario = args.scenario;
  const port = parseInt(args.port, 10);

  if (!framework || !scenario || !port) {
    console.error('Usage: node server.js --framework <name> --scenario <name> --port <number>');
    process.exit(1);
  }

  try {
    let frameworkModule;
    let app;
    let serverInstance;

    // Load framework
    if (framework === 'express') {
      frameworkModule = require('express');
      app = frameworkModule();
      app.set('etag', false);
      app.set('x-powered-by', false);

      // Health check
      app.get('/__ready', (_req, res) => res.send('OK'));

      // Load and setup scenario
      const scenarioModule = require(path.join(__dirname, 'scenarios', `${scenario}.js`));
      await scenarioModule.setup(app, framework);

      // Start server
      await new Promise((resolve, reject) => {
        serverInstance = app.listen(port, '127.0.0.1', resolve);
        serverInstance.once('error', reject);
      });
    } else if (framework === 'fastify') {
      frameworkModule = require('fastify');
      app = frameworkModule({ logger: false });

      // Health check
      app.get('/__ready', async (_req, reply) => reply.send('OK'));

      // Load and setup scenario
      const scenarioModule = require(path.join(__dirname, 'scenarios', `${scenario}.js`));
      await scenarioModule.setup(app, framework);

      // Start server
      await app.listen({ port, host: '127.0.0.1' });
    } else if (framework === 'uwestjs') {
      // Use UwsPlatformAdapter - this is YOUR implementation
      const { UwsPlatformAdapter } = require('../dist/http/platform/uws-platform.adapter');

      // Create adapter with benchmark-friendly settings
      const adapter = new UwsPlatformAdapter({
        maxBodySize: 10 * 1024 * 1024,
        etag: false,
        bodyParser: {
          json: true,
          urlencoded: true,
        },
      });

      // Health check - use adapter's get() method
      adapter.get('/__ready', (_req, res) => {
        res.status(200).send('OK');
      });

      // Load and setup scenario - pass adapter as the app
      const scenarioModule = require(path.join(__dirname, 'scenarios', `${scenario}.js`));
      await scenarioModule.setup(adapter, framework);

      // Start listening
      await new Promise((resolve, reject) => {
        adapter.listen(port, '127.0.0.1', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      app = adapter;
    } else {
      throw new Error(`Unknown framework: ${framework}`);
    }

    console.log(`${framework} server listening on port ${port}`);

    // Graceful shutdown handlers
    function shutdown() {
      const force = setTimeout(() => process.exit(0), 2000).unref();
      if (framework === 'fastify' && app) {
        app.close(() => {
          clearTimeout(force);
          process.exit(0);
        });
      } else if (framework === 'uwestjs' && app) {
        app.close().then(() => {
          clearTimeout(force);
          process.exit(0);
        });
      } else if (serverInstance) {
        serverInstance.close(() => {
          clearTimeout(force);
          process.exit(0);
        });
      } else {
        clearTimeout(force);
        process.exit(0);
      }
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(`Failed to start ${framework} server:`, error);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
