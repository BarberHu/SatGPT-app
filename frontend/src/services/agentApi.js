import axios from 'axios';
import { resolveBrowserEndpoint } from '../utils/runtimeUrls';

const AGENT_API_BASE =
  resolveBrowserEndpoint(process.env.REACT_APP_API_URL, '');

const normalizeAgentApiError = (error, fallbackMessage) => {
  const detail =
    error?.response?.data?.detail ||
    error?.response?.data?.message ||
    error?.message ||
    fallbackMessage;

  const normalized = new Error(detail);
  normalized.cause = error;
  normalized.status = error?.response?.status || null;
  normalized.payload = error?.response?.data || null;
  return normalized;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postWithRetry = async (url, payload, options = {}) => {
  const {
    retries = 0,
    retryDelayMs = 300,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await axios.post(url, payload);
    } catch (error) {
      lastError = error;
      const isNetworkError = !error?.response;
      const canRetry = attempt < retries && isNetworkError;
      if (!canRetry) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
};

export const getFloodImages = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-images`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to fetch flood imagery:', error);
    throw normalizeAgentApiError(error, 'Failed to fetch flood imagery.');
  }
};

export const getFloodImpact = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-impact`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to fetch flood impact assessment:', error);
    throw normalizeAgentApiError(error, 'Failed to fetch flood impact assessment.');
  }
};

export const refreshFloodConfirmation = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-confirmation/refresh`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to refresh flood confirmation context:', error);
    throw normalizeAgentApiError(error, 'Failed to refresh boundary and recommended datasets.');
  }
};

export const renderRecommendedLayer = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/recommended-layer-render`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to render recommended layer:', error);
    throw normalizeAgentApiError(error, 'Failed to render recommended layer.');
  }
};

export const getAgentRasterDownloadUrl = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/agent-raster-download`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to prepare agent raster download:', error);
    throw normalizeAgentApiError(error, 'Failed to prepare raster download.');
  }
};

export const downloadAgentRasterFile = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/agent-raster-download-file`, params, {
      responseType: 'blob',
    });
    return {
      blob: response.data,
      filename: getFilenameFromDisposition(response.headers?.['content-disposition']),
      scale: response.headers?.['x-satgpt-raster-scale'] || null,
    };
  } catch (error) {
    console.error('Failed to download agent raster file:', error);
    throw await normalizeAgentDownloadError(error, 'Failed to download raster file.');
  }
};

const getFilenameFromDisposition = (contentDisposition) => {
  const match = String(contentDisposition || '').match(/filename="?([^"]+)"?/i);
  return match?.[1] || null;
};

const normalizeAgentDownloadError = async (error, fallbackMessage) => {
  let detail = null;
  const blob = error?.response?.data;
  if (blob instanceof Blob) {
    try {
      const text = await blob.text();
      detail = JSON.parse(text)?.detail || text;
    } catch (parseError) {
      detail = null;
    }
  }

  const normalized = new Error(detail || error?.message || fallbackMessage);
  normalized.cause = error;
  normalized.status = error?.response?.status || null;
  normalized.payload = error?.response?.data || null;
  return normalized;
};

export const searchLocationCandidates = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/location-search`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to search location candidates:', error);
    throw normalizeAgentApiError(error, 'Failed to search location candidates.');
  }
};

export const syncBusinessLayers = async (params) => {
  try {
    const response = await postWithRetry(
      `${AGENT_API_BASE}/api/business-layers/upsert`,
      params,
      { retries: 2, retryDelayMs: 400 }
    );
    return response.data;
  } catch (error) {
    console.error('Failed to sync business layers:', error);
    throw normalizeAgentApiError(error, 'Failed to sync business layers.');
  }
};

export const resolveBusinessLayers = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/business-layers/batch-resolve`, params);
    return response.data;
  } catch (error) {
    console.error('Failed to resolve business layers:', error);
    throw normalizeAgentApiError(error, 'Failed to resolve business layers.');
  }
};

export const checkGEEStatus = async () => {
  try {
    const response = await axios.get(`${AGENT_API_BASE}/api/gee-status`);
    return response.data;
  } catch (error) {
    console.error('Failed to check GEE status:', error);
    throw normalizeAgentApiError(error, 'Failed to check GEE status.');
  }
};

export const checkAgentHealth = async () => {
  try {
    const response = await axios.get(`${AGENT_API_BASE}/`);
    return response.data;
  } catch (error) {
    console.error('Failed to check agent health:', error);
    throw normalizeAgentApiError(error, 'Failed to check agent health.');
  }
};

const agentApi = {
  getFloodImages,
  getFloodImpact,
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
