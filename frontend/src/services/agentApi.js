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
  checkGEEStatus,
  checkAgentHealth,
};

export default agentApi;
