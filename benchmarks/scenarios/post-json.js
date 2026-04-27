'use strict';

module.exports = {
  name: 'post-json',
  path: '/api/data',
  wrk: {
    script: 'post-json.lua',
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    if (framework === 'fastify') {
      app.post('/api/data', (req, reply) => {
        reply.send({
          received: req.body,
          timestamp: 1234567890,
        });
      });
    } else {
      // Express and uWestJS use same API
      app.post('/api/data', (req, res) => {
        res.json({
          received: req.body,
          timestamp: 1234567890,
        });
      });
    }
  },
};
