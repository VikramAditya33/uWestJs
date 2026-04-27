'use strict';

module.exports = {
  name: 'headers',
  path: '/api/headers',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    const handler = (req, res) => {
      res.json({
        userAgent: req.get('user-agent'),
        accept: req.get('accept'),
        host: req.get('host'),
        connection: req.get('connection'),
      });
    };

    if (framework === 'fastify') {
      app.get('/api/headers', (req, reply) => {
        reply.send({
          userAgent: req.headers['user-agent'],
          accept: req.headers['accept'],
          host: req.headers['host'],
          connection: req.headers['connection'],
        });
      });
    } else if (framework === 'express' || framework === 'uwestjs') {
      // Express and uWestJS use same API
      app.get('/api/headers', handler);
    }
  },
};
