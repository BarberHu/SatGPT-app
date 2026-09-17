import httpClient from '../api/httpClient';

const responseData = async (requestPromise) => (await requestPromise).data;

export const getFloodImages = (params, options = {}) => responseData(httpClient.post(
  '/api/flood-images',
  params,
  { fallbackMessage: 'Failed to fetch flood imagery.', ...options }
));

export const getFloodImpact = (params, options = {}) => responseData(httpClient.post(
  '/api/flood-impact',
  params,
  { fallbackMessage: 'Failed to fetch flood impact assessment.', ...options }
));

export const refreshFloodConfirmation = (params, options = {}) => responseData(httpClient.post(
  '/api/flood-confirmation/refresh',
  params,
  { fallbackMessage: 'Failed to refresh boundary and recommended datasets.', ...options }
));

export const getFloodLayerCatalog = (options = {}) => responseData(httpClient.get(
  '/api/flood-layer-catalog',
  { fallbackMessage: 'Failed to fetch the flood layer catalog.', ...options }
));

export const renderRecommendedLayer = (params, options = {}) => responseData(httpClient.post(
  '/api/recommended-layer-render',
  params,
  { fallbackMessage: 'Failed to render recommended layer.', ...options }
));

export const getAgentRasterDownloadUrl = (params, options = {}) => responseData(httpClient.post(
  '/api/agent-raster-download',
  params,
  { fallbackMessage: 'Failed to prepare agent raster download.', ...options }
));

const getFilenameFromDisposition = (contentDisposition) => {
  const match = String(contentDisposition || '').match(/filename="?([^"]+)"?/i);
  return match?.[1] || null;
};

export const downloadAgentRasterFile = async (params, options = {}) => {
  const response = await httpClient.post('/api/agent-raster-download-file', params, {
    fallbackMessage: 'Failed to download raster file.',
    responseType: 'blob',
    ...options,
  });
  return {
    blob: response.data,
    filename: getFilenameFromDisposition(response.headers?.['content-disposition']),
    scale: response.headers?.['x-satgpt-raster-scale'] || null,
  };
};

export const searchLocationCandidates = (params, options = {}) => responseData(httpClient.post(
  '/api/location-search',
  params,
  { fallbackMessage: 'Failed to search location candidates.', ...options }
));

export const syncBusinessLayers = (params, options = {}) => responseData(httpClient.post(
  '/api/business-layers/upsert',
  params,
  {
    fallbackMessage: 'Failed to sync business layers.',
    retries: 2,
    retryDelayMs: 400,
    ...options,
  }
));

export const resolveBusinessLayers = (params, options = {}) => responseData(httpClient.post(
  '/api/business-layers/batch-resolve',
  params,
  { fallbackMessage: 'Failed to resolve business layers.', ...options }
));

export const checkGEEStatus = (options = {}) => responseData(httpClient.get('/api/gee-status', {
  fallbackMessage: 'Failed to check GEE status.',
  ...options,
}));

export const checkAgentHealth = (options = {}) => responseData(httpClient.get('/', {
  fallbackMessage: 'Failed to check agent health.',
  ...options,
}));

const agentApi = {
  getFloodImages,
  getFloodImpact,
  getFloodLayerCatalog,
  refreshFloodConfirmation,
  downloadAgentRasterFile,
  renderRecommendedLayer,
  getAgentRasterDownloadUrl,
  searchLocationCandidates,
  syncBusinessLayers,
  resolveBusinessLayers,
  checkGEEStatus,
  checkAgentHealth,
};

export default agentApi;
