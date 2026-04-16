const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  const agentTarget =
    process.env.REACT_APP_AGENT_API_URL || 'http://localhost:8000';
  const runtimeTarget =
    process.env.REACT_APP_COPILOTKIT_PROXY_TARGET || 'http://localhost:5000';

  // Proxy legacy routes to FastAPI for backward compatibility.
  app.use(
    [
      '/get_default',
      '/get_historical_map',
      '/get_unsupervised_map',
      '/get_flood_hotspot_map',
      '/get_water_regime_change_map',
      '/chatGPT',
      '/get_script',
      '/get_pdf',
      '/flask-health-check',
    ],
    createProxyMiddleware({
      target: agentTarget,
      changeOrigin: true,
    })
  );

  // Proxy FloodAgent API requests to FastAPI.
  app.use(
    '/api',
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
