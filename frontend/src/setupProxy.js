const { createProxyMiddleware } = require('http-proxy-middleware');

const requireEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

module.exports = function(app) {
  const serviceHost = requireEnv('SATGPT_SERVICE_HOST');
  const agentTarget = `http://${serviceHost}:${requireEnv('AGENT_PORT')}`;
  const runtimeTarget = `http://${serviceHost}:${requireEnv('RUNTIME_PORT')}`;

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
