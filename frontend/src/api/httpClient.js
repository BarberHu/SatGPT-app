import axios from 'axios';

const axiosClient = axios.create({
  baseURL: '',
});

export class ApiError extends Error {
  constructor(message, {
    cause = null,
    status = null,
    payload = null,
    code = null,
    isCanceled = false,
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.cause = cause;
    this.status = status;
    this.payload = payload;
    this.code = code;
    this.isCanceled = isCanceled;
  }
}

export const isRequestCanceled = (error) => Boolean(
  error?.isCanceled
  || error?.code === 'ERR_CANCELED'
  || error?.name === 'CanceledError'
  || error?.name === 'AbortError'
  || axios.isCancel?.(error)
);

const readPayloadMessage = async (payload) => {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof Blob !== 'undefined' && payload instanceof Blob) {
    try {
      const text = await payload.text();
      if (!text) {
        return null;
      }
      try {
        const parsed = JSON.parse(text);
        return parsed?.detail || parsed?.message || text;
      } catch (error) {
        return text;
      }
    } catch (error) {
      return null;
    }
  }
  if (typeof payload !== 'object') {
    return String(payload);
  }
  return payload.detail || payload.message || null;
};

export const normalizeHttpError = async (error, fallbackMessage = 'Request failed.') => {
  if (error instanceof ApiError) {
    return error;
  }

  const canceled = isRequestCanceled(error);
  const payload = error?.response?.data || null;
  const payloadMessage = await readPayloadMessage(payload);
  return new ApiError(
    canceled ? 'Request cancelled.' : (payloadMessage || error?.message || fallbackMessage),
    {
      cause: error,
      status: error?.response?.status || null,
      payload,
      code: error?.code || null,
      isCanceled: canceled,
    }
  );
};

const waitForRetry = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new ApiError('Request cancelled.', { code: 'ERR_CANCELED', isCanceled: true }));
    return;
  }

  let timer = null;
  const handleAbort = () => {
    if (timer) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', handleAbort);
    reject(new ApiError('Request cancelled.', { code: 'ERR_CANCELED', isCanceled: true }));
  };
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', handleAbort);
    resolve();
  }, Math.max(0, delayMs));
  signal?.addEventListener('abort', handleAbort, { once: true });
});

export const request = async (config, {
  fallbackMessage = 'Request failed.',
  retries = 0,
  retryDelayMs = 300,
} = {}) => {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await axiosClient.request(config);
    } catch (error) {
      lastError = await normalizeHttpError(error, fallbackMessage);
      const canRetry = (
        attempt < retries
        && !lastError.status
        && !lastError.isCanceled
      );
      if (!canRetry) {
        throw lastError;
      }
      await waitForRetry(retryDelayMs, config.signal);
    }
  }

  throw lastError;
};

const splitOptions = (options = {}) => {
  const {
    fallbackMessage,
    retries,
    retryDelayMs,
    ...config
  } = options;
  return {
    config,
    policy: { fallbackMessage, retries, retryDelayMs },
  };
};

export const httpClient = {
  get: (url, options = {}) => {
    const { config, policy } = splitOptions(options);
    return request({ ...config, method: 'get', url }, policy);
  },
  post: (url, data, options = {}) => {
    const { config, policy } = splitOptions(options);
    return request({ ...config, data, method: 'post', url }, policy);
  },
};

export default httpClient;
