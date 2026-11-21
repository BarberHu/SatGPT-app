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
    expect(proxy['/api'].changeOrigin).toBe(false);
    expect(proxy['/health'].changeOrigin).toBe(true);
  });

  test('scopes dev proxy routes to the public base and preserves the internal query string', () => {
    const proxy = createProxyConfig({ SATGPT_BASE_PATH: '/satgpt/' });
    expect(Object.keys(proxy)).toEqual(['/satgpt/api', '/satgpt/health', '/satgpt/readyz']);
    expect(proxy['/satgpt/api'].rewrite('/satgpt/api/harness/tasks/task/events?after=7'))
      .toBe('/api/harness/tasks/task/events?after=7');
    expect(proxy['/satgpt/readyz'].rewrite('/satgpt/readyz')).toBe('/readyz');
  });

  test.each(['satgpt/', '/satgpt', '//satgpt/', '/satgpt/../'])('rejects an invalid public base %s', base => {
    expect(() => createProxyConfig({ SATGPT_BASE_PATH: base })).toThrow('SATGPT_BASE_PATH');
  });
});
