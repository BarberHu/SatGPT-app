// @vitest-environment node
import { createProxyConfig } from '../../vite.config.mjs';

describe('Vite proxy configuration', () => {
  test('keeps browser API calls on the established agent and runtime routes', () => {
    const proxy = createProxyConfig({
      SATGPT_SERVICE_HOST: 'services.internal',
      AGENT_PORT: '8100',
      RUNTIME_PORT: '5100',
    });

    expect(proxy['/api'].target).toBe('http://services.internal:8100');
    expect(proxy['/health'].target).toBe('http://services.internal:8100');
    expect(proxy['/agent'].target).toBe('http://services.internal:8100');
    expect(proxy['/copilotkit'].target).toBe('http://services.internal:5100');
    expect(Object.values(proxy).every((entry) => entry.changeOrigin)).toBe(true);
  });
});
