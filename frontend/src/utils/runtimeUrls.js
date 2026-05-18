export const resolveBrowserEndpoint = (configuredValue, fallbackValue) => {
  return String(configuredValue || '').trim() || fallbackValue;
};
