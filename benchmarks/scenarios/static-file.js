'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'static-file',
  path: '/static/test-10kb.txt',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    const assetsDir = path.join(__dirname, '../assets');
    const filePath = path.join(assetsDir, 'test-10kb.txt');

    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, 'A'.repeat(10 * 1024));
    }

    // Preload file content for fair benchmarking
    // All frameworks serve from memory to avoid file descriptor limits under high load
    const fileContent = fs.readFileSync(filePath);

    if (framework === 'express') {
      app.get('/static/test-10kb.txt', (_req, res) => {
        res.type('text/plain');
        res.send(fileContent);
      });
    } else if (framework === 'fastify') {
      app.get('/static/test-10kb.txt', (_req, reply) => {
        reply.type('text/plain');
        reply.send(fileContent);
      });
    } else if (framework === 'uwestjs') {
      app.get('/static/test-10kb.txt', (_req, res) => {
        res.type('text/plain');
        res.send(fileContent);
      });
    }
  },
};
