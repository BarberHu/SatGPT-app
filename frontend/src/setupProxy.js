const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  const publicHost = process.env.SATGPT_PUBLIC_HOST || 'localhost';
  const agentPort = process.env.AGENT_PORT || '8000';
  const runtimePort = process.env.RUNTIME_PORT || '5000';
  const agentTarget = `http://${publicHost}:${agentPort}`;
  const runtimeTarget = `http://${publicHost}:${runtimePort}`;

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
