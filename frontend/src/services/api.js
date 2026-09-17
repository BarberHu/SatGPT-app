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

export const getAgentRasterLayers = (params, options = {}) => responseData(httpClient.post(
  '/api/agent-raster-layers',
  params,
  { fallbackMessage: 'Raster layer request failed.', ...options }
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

export const sendChatMessage = (message, options = {}) => responseData(httpClient.post(
  '/api/chat',
  { message },
  { fallbackMessage: 'Failed to send the Ask request.', ...options }
));

export const getGEEScript = (message, options = {}) => responseData(httpClient.post(
  '/api/scripts/gee',
  { message },
  { fallbackMessage: 'Failed to generate the GEE script.', ...options }
));

export const getPDF = (script, options = {}) => responseData(httpClient.post(
  '/api/scripts/pdf',
  { script },
  { fallbackMessage: 'Failed to generate the PDF.', responseType: 'blob', ...options }
));

const apiService = {
  healthCheck,
  getDefaultMap,
  getHistoricalMap,
  getAgentRasterLayers,
  getUnsupervisedMap,
  getFloodHotspotMap,
  sendChatMessage,
  getGEEScript,
  getPDF,
};

export default apiService;
