const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  const serviceHost = process.env.SATGPT_SERVICE_HOST || '127.0.0.1';
  const agentPort = process.env.AGENT_PORT || '8000';
  const runtimePort = process.env.RUNTIME_PORT || '5000';
  const agentTarget = `http://${serviceHost}:${agentPort}`;
  const runtimeTarget = `http://${serviceHost}:${runtimePort}`;

  // Proxy FloodAgent API requests to FastAPI.
  app.use(
    '/api',
    createProxyMiddleware({
      target: agentTarget,
      changeOrigin: true,
    })
  );

  app.use(
    ['/health', '/agent'],
    createProxyMiddleware({
      target: agentTarget,
      changeOrigin: true,
    })
  );

  // Proxy CopilotKit requests to the runtime service.
  app.use(
    '/copilotkit',
    createProxyMiddleware({
      target: runtimeTarget,
      changeOrigin: true,
    })
  );
};
