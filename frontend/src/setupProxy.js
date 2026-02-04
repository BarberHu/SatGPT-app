const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Proxy API requests to Flask backend (端口 5001)
  app.use(
    ['/get_default', '/get_historical_map', '/get_unsupervised_map', '/get_flood_hotspot_map', '/chatGPT', '/get_script', '/get_pdf', '/flask-health-check'],
    createProxyMiddleware({
      target: 'http://localhost:5001',
      changeOrigin: true,
    })
  );
  
  // Proxy specific Flask static files (geojson, countries.json, etc.)
  // Use specific file paths instead of entire /static folder
  app.use(
    [
      '/static/HFMT_Fishnet_3_FeaturesToJSO.geojson',
      '/static/countries.json',
      '/static/ee_api_js.js',
      '/static/images'
    ],
    createProxyMiddleware({
      target: 'http://localhost:5001',
      changeOrigin: true,
    })
  );
  
  // Proxy FloodAgent API requests to FastAPI backend (端口 8000)
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:8000',
      changeOrigin: true,
    })
  );
  
  // Proxy CopilotKit requests to Runtime (端口 5000)
  app.use(
    '/copilotkit',
    createProxyMiddleware({
      target: 'http://localhost:5000',
      changeOrigin: true,
    })
  );
};
