import httpClient from '../api/httpClient';

const responseData = async (requestPromise) => (await requestPromise).data;

export const healthCheck = (options = {}) => responseData(httpClient.get('/health', {
  fallbackMessage: 'Health check failed.',
  ...options,
}));

export const getDefaultMap = (options = {}) => responseData(httpClient.get('/api/maps/default', {
  fallbackMessage: 'Failed to load the default map.',
  ...options,
}));

export const getHistoricalMap = (params, options = {}) => responseData(httpClient.post(
  '/api/maps/historical',
  params,
  { fallbackMessage: 'Failed to load historical flood data.', ...options }
));

export const getUnsupervisedMap = (params, options = {}) => responseData(httpClient.post(
  '/api/maps/unsupervised',
  params,
  { fallbackMessage: 'Failed to load unsupervised map data.', ...options }
));

export const getFloodHotspotMap = (params, options = {}) => responseData(httpClient.post(
  '/api/maps/flood-hotspot',
  params,
  { fallbackMessage: 'Failed to load flood hotspot data.', ...options }
));

const apiService = {
  healthCheck,
  getDefaultMap,
  getHistoricalMap,
  getUnsupervisedMap,
  getFloodHotspotMap,
};

export default apiService;
