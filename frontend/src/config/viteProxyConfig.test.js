// @vitest-environment node
import { createProxyConfig } from '../../vite.config.mjs';

describe('Vite proxy configuration', () => {
  test('routes all API requests and readiness to the unified backend', () => {
    const proxy = createProxyConfig({
      SATGPT_SERVICE_HOST: 'services.internal',
      AGENT_PORT: '8100',
      HARNESS_PORT: '8200',
    });

    expect(proxy['/api'].target).toBe('http://services.internal:8100');
    expect(proxy['/health'].target).toBe('http://services.internal:8100');
    expect(proxy['/readyz'].target).toBe('http://services.internal:8100');
    expect(Object.keys(proxy)).toEqual(['/api', '/health', '/readyz']);
    expect(Object.values(proxy).every((entry) => entry.changeOrigin)).toBe(true);
  });
});
