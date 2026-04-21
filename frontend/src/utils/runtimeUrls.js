const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const isBrowser = typeof window !== 'undefined';

const getCurrentHostname = () => {
  if (!isBrowser) {
    return '';
  }
  return window.location.hostname || '';
};

const isLoopbackHostname = (hostname) => LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());

const isRemotePage = () => {
  const currentHostname = getCurrentHostname();
  return currentHostname !== '' && !isLoopbackHostname(currentHostname);
};

const parseUrl = (value) => {
  try {
    return new URL(value, isBrowser ? window.location.origin : 'http://localhost');
  } catch (error) {
    return null;
  }
};

export const resolveBrowserEndpoint = (configuredValue, fallbackValue) => {
  const value = String(configuredValue || '').trim();

  if (!value) {
    return fallbackValue;
  }

  const parsed = parseUrl(value);
  if (!parsed) {
    return value;
  }

  if (isRemotePage() && isLoopbackHostname(parsed.hostname)) {
    return fallbackValue;
  }

  return value;
};
