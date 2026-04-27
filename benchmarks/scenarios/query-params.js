'use strict';

// Query parameter parsing benchmark
// Tests query string parsing performance

module.exports = {
  name: 'query-params',
  path: '/search?q=benchmark&limit=10&offset=0&sort=desc',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    if (framework === 'express' || framework === 'uwestjs') {
      app.get('/search', (req, res) => {
        res.json({
          query: req.query.q,
          limit: req.query.limit,
          offset: req.query.offset,
          sort: req.query.sort,
        });
      });
    } else if (framework === 'fastify') {
      app.get('/search', (req, reply) => {
        reply.send({
          query: req.query.q,
          limit: req.query.limit,
          offset: req.query.offset,
          sort: req.query.sort,
        });
      });
    }
  },
};
