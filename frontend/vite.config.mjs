import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(frontendRoot, '..');
const config = createRequire(path.join(frontendRoot, 'vite.config.mjs'))('./projectEnv.cjs');

function getPort(env, name, fallback) {
  return config.port({ [name]: String(fallback), ...env }, name);
}

export function createProxyConfig(env) {
  const serviceHost = env.SATGPT_SERVICE_HOST || '127.0.0.1';
  const target = `http://${serviceHost}:${getPort(env, 'AGENT_PORT', 8000)}`;

  return {
    '/api': { target, changeOrigin: true },
    '/health': { target, changeOrigin: true },
    '/readyz': { target, changeOrigin: true },
  };
}

export default defineConfig(({ mode }) => {
  const env = config.loadProjectEnv(projectRoot);
  config.validateFrontend(env, { map: mode !== 'test' });

  return {
    root: frontendRoot,
    plugins: [react()],
    envDir: false,
    envPrefix: [],
    define: config.publicConfig(env),
    resolve: {
      alias: {
        '@': path.resolve(frontendRoot, 'src'),
      },
    },
    server: {
      host: env.SATGPT_ALLOW_REMOTE_HARNESS === 'true'
        ? env.FRONTEND_HOST
        : '127.0.0.1',
      port: config.port(env, 'FRONTEND_PORT'),
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
