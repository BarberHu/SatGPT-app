import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.mjs';

export default mergeConfig(viteConfig({ mode: 'test' }), defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    maxWorkers: 2,
  },
}));
