import axios from 'axios';

const AGENT_API_BASE =
  process.env.REACT_APP_AGENT_API_URL || `http://${window.location.hostname}:8000`;

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

export const getFloodImages = async (params, config = {}) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-images`, params, config);
    return response.data;
  } catch (error) {
    console.error('Failed to fetch flood imagery:', error);
    throw normalizeAgentApiError(error, 'Failed to fetch flood imagery.');
  }
};

export const getFloodImpact = async (params, config = {}) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-impact`, params, config);
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

export const renderRecommendedLayer = async (params, config = {}) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/recommended-layer-render`, params, config);
    return response.data;
  } catch (error) {
    console.error('Failed to render recommended layer:', error);
    throw normalizeAgentApiError(error, 'Failed to render recommended layer.');
  }
};

export const searchLocationCandidates = async (params, config = {}) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/location-search`, params, config);
    return response.data;
  } catch (error) {
    console.error('Failed to search location candidates:', error);
    throw normalizeAgentApiError(error, 'Failed to search location candidates.');
  }
};

export const syncBusinessLayers = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/business-layers/upsert`, params);
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
  renderRecommendedLayer,
  searchLocationCandidates,
  syncBusinessLayers,
  resolveBusinessLayers,
  checkGEEStatus,
  checkAgentHealth,
};

export default agentApi;
