import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(frontendRoot, '..');

function getPort(env, name, fallback) {
  const value = Number.parseInt(env[name] || '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

export function createProxyConfig(env) {
  const serviceHost = env.SATGPT_SERVICE_HOST || '127.0.0.1';
  const agentTarget = `http://${serviceHost}:${getPort(env, 'AGENT_PORT', 8000)}`;
  const runtimeTarget = `http://${serviceHost}:${getPort(env, 'RUNTIME_PORT', 5000)}`;

  return {
    '/api': { target: agentTarget, changeOrigin: true },
    '/health': { target: agentTarget, changeOrigin: true },
    '/agent': { target: agentTarget, changeOrigin: true },
    '/copilotkit': { target: runtimeTarget, changeOrigin: true },
  };
}

export default defineConfig(({ mode }) => {
  const projectEnv = loadEnv(mode, projectRoot, '');
  const frontendEnv = loadEnv(mode, frontendRoot, '');
  const env = { ...projectEnv, ...frontendEnv, ...process.env };

  return {
    root: frontendRoot,
    plugins: [react()],
    envPrefix: ['VITE_', 'REACT_APP_'],
    define: {
      'import.meta.env.REACT_APP_MAPBOX_ACCESS_TOKEN': JSON.stringify(env.REACT_APP_MAPBOX_ACCESS_TOKEN || ''),
      'import.meta.env.REACT_APP_MAPBOX_STYLE_URL': JSON.stringify(env.REACT_APP_MAPBOX_STYLE_URL || ''),
    },
    resolve: {
      alias: {
        // CopilotKit re-exports its Node telemetry client from the browser package.
        // Keep that optional telemetry path out of the browser runtime.
        '@segment/analytics-node': path.resolve(frontendRoot, 'src/shims/segmentAnalyticsNode.js'),
      },
    },
    server: {
      host: env.FRONTEND_HOST || env.HOST || '0.0.0.0',
      port: getPort(env, 'FRONTEND_PORT', getPort(env, 'PORT', 3000)),
      strictPort: true,
      proxy: createProxyConfig(env),
    },
    build: {
      outDir: 'build',
      assetsDir: 'static',
      emptyOutDir: true,
      sourcemap: String(env.GENERATE_SOURCEMAP).toLowerCase() === 'true',
      target: 'es2018',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          onlyExplicitManualChunks: true,
          manualChunks(id) {
            if (id.includes('/node_modules/@copilotkit/')) return 'copilotkit';
            return undefined;
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      css: true,
    },
  };
});
