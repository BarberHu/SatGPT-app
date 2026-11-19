import { ensureBrowserSession } from '../harness/browserSession';
import httpClient from '../api/httpClient';

const responseData = async (requestPromise) => (await requestPromise).data;

export const syncBusinessLayers = async (params, options = {}) => {
  await ensureBrowserSession();
  return responseData(httpClient.post(
    '/api/business-layers/upsert',
    params,
    {
      fallbackMessage: 'Failed to sync business layers.',
      retries: 2,
      retryDelayMs: 400,
    ...options,
  }
  ));
};
