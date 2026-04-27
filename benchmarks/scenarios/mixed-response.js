'use strict';

module.exports = {
  name: 'mixed-response',
  path: '/api/mixed',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    if (framework === 'fastify') {
      app.get('/api/mixed', (_req, reply) => {
        reply.send({
          status: 'success',
          data: {
            id: 123,
            name: 'Test',
            items: [1, 2, 3, 4, 5],
          },
        });
      });
    } else {
      // Express and uWestJS use same API
      app.get('/api/mixed', (_req, res) => {
        res.json({
          status: 'success',
          data: {
            id: 123,
            name: 'Test',
            items: [1, 2, 3, 4, 5],
          },
        });
      });
    }
  },
};
