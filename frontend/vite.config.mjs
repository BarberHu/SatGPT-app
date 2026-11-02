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
  const basicTarget = `http://${serviceHost}:${getPort(env, 'AGENT_PORT', 8000)}`;
  const harnessTarget = `http://${serviceHost}:${getPort(env, 'HARNESS_PORT', 8001)}`;

  return {
    '/api/harness': { target: harnessTarget, changeOrigin: true },
    '/api/previews': { target: harnessTarget, changeOrigin: true },
    '/api': { target: basicTarget, changeOrigin: true },
    '/health': { target: basicTarget, changeOrigin: true },
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
        '@': path.resolve(frontendRoot, 'src'),
      },
    },
    server: {
      host: env.SATGPT_ALLOW_REMOTE_HARNESS === 'true'
        ? (env.FRONTEND_HOST || env.HOST || '0.0.0.0')
        : '127.0.0.1',
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
    },
  };
});
