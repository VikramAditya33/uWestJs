'use strict';

module.exports = {
  name: 'hello-world',
  path: '/',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    if (framework === 'fastify') {
      app.get('/', (_req, reply) => {
        reply.send('Hello World');
      });
    } else {
      // Express and uWestJS use same API
      app.get('/', (_req, res) => {
        res.send('Hello World');
      });
    }
  },
};
