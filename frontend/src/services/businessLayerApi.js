import httpClient from '../api/httpClient';

const responseData = async (requestPromise) => (await requestPromise).data;

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
