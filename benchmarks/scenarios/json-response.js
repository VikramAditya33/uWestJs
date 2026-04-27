'use strict';

module.exports = {
  name: 'json-response',
  path: '/json',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    const data = {
      message: 'Hello World',
      timestamp: 1234567890,
      data: {
        users: ['Alice', 'Bob', 'Charlie'],
        count: 3,
        active: true,
      },
    };

    if (framework === 'fastify') {
      app.get('/json', (_req, reply) => {
        reply.send(data);
      });
    } else {
      // Express and uWestJS use same API
      app.get('/json', (_req, res) => {
        res.json(data);
      });
    }
  },
};
