vi.mock('axios', () => {
  const request = vi.fn();
  const axios = {
    __mockRequest: request,
    create: vi.fn(() => ({ request })),
    isCancel: vi.fn((error) => Boolean(error?.__CANCEL__)),
  };
  return { default: axios, ...axios };
});

import axios from 'axios';
import {
  httpClient,
  isRequestCanceled,
} from './httpClient';

const mockRequest = axios.__mockRequest;

describe('httpClient', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    axios.isCancel.mockClear();
  });

  test('uses same-origin URLs and forwards AbortSignal', async () => {
    const controller = new AbortController();
    mockRequest.mockResolvedValueOnce({ data: { ok: true } });

    const response = await httpClient.post('/api/example', { id: 1 }, {
      signal: controller.signal,
      fallbackMessage: 'Example failed.',
    });

    expect(response.data).toEqual({ ok: true });
    expect(mockRequest).toHaveBeenCalledWith({
      data: { id: 1 },
      method: 'post',
      signal: controller.signal,
      url: '/api/example',
    });
  });

  test('normalizes backend errors into ApiError', async () => {
    mockRequest.mockRejectedValueOnce({
      message: 'Request failed with status code 422',
      response: { status: 422, data: { detail: 'Invalid AOI.' } },
    });

    await expect(httpClient.get('/api/example', {
      fallbackMessage: 'Example failed.',
    })).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Invalid AOI.',
      status: 422,
      payload: { detail: 'Invalid AOI.' },
      isCanceled: false,
    });
  });

  test('retries network failures without retrying HTTP failures', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: { ok: true } });

    await expect(httpClient.post('/api/example', {}, {
      retries: 1,
      retryDelayMs: 0,
    })).resolves.toMatchObject({ data: { ok: true } });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  test('marks canceled requests and does not retry them', async () => {
    const canceledError = Object.assign(new Error('canceled'), {
      code: 'ERR_CANCELED',
    });
    mockRequest.mockRejectedValueOnce(canceledError);

    const result = httpClient.get('/api/example', { retries: 2 });
    await expect(result).rejects.toMatchObject({
      name: 'ApiError',
      isCanceled: true,
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(isRequestCanceled(canceledError)).toBe(true);
  });

  test('aborts while waiting to retry a network failure', async () => {
    const controller = new AbortController();
    mockRequest.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('Network Error');
    });

    await expect(httpClient.get('/api/example', {
      retries: 2,
      retryDelayMs: 1000,
      signal: controller.signal,
    })).rejects.toMatchObject({ isCanceled: true });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
