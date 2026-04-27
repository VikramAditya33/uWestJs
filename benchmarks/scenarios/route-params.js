'use strict';

// Route parameter extraction benchmark
// Tests path parameter parsing performance

module.exports = {
  name: 'route-params',
  path: '/users/12345/posts/67890',
  wrk: {
    threads: 4,
    connections: 200,
  },
  setup(app, framework) {
    if (framework === 'express' || framework === 'uwestjs') {
      app.get('/users/:userId/posts/:postId', (req, res) => {
        res.json({
          userId: req.params.userId,
          postId: req.params.postId,
          path: req.path,
        });
      });
    } else if (framework === 'fastify') {
      app.get('/users/:userId/posts/:postId', (req, reply) => {
        reply.send({
          userId: req.params.userId,
          postId: req.params.postId,
          path: req.url,
        });
      });
    }
  },
};
