/**
 * FloodAgent API 服务
 * 用于与 FastAPI 后端通信
 */

import axios from 'axios';

// FastAPI Agent 后端地址
const AGENT_API_BASE = process.env.REACT_APP_AGENT_API_URL || 'http://localhost:8000';

/**
 * 获取洪水事件影像
 * @param {Object} params - 请求参数
 * @param {string} params.pre_date - 洪水前日期
 * @param {string} params.peek_date - 洪峰日期
 * @param {string} params.after_date - 洪水后日期
 * @param {number} params.longitude - 经度
 * @param {number} params.latitude - 纬度
 * @param {Object} params.bounds - 边界框
 * @param {Object} params.geojson - GeoJSON 边界
 */
export const getFloodImages = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-images`, params);
    return response.data;
  } catch (error) {
    console.error('获取洪水影像失败:', error);
    throw error;
  }
};

/**
 * 获取洪水损失评估
 * @param {Object} params - 请求参数
 * @param {string} params.pre_date - 洪水前日期
 * @param {string} params.peek_date - 洪峰日期
 * @param {Object} params.bounds - 边界框
 * @param {Object} params.geojson - GeoJSON 边界
 */
export const getFloodImpact = async (params) => {
  try {
    const response = await axios.post(`${AGENT_API_BASE}/api/flood-impact`, params);
    return response.data;
  } catch (error) {
    console.error('获取洪水损失评估失败:', error);
    throw error;
  }
};

/**
 * 检查 GEE 服务状态
 */
export const checkGEEStatus = async () => {
  try {
    const response = await axios.get(`${AGENT_API_BASE}/api/gee-status`);
    return response.data;
  } catch (error) {
    console.error('检查 GEE 状态失败:', error);
    throw error;
  }
};

/**
 * 检查 Agent 服务健康状态
 */
export const checkAgentHealth = async () => {
  try {
    const response = await axios.get(`${AGENT_API_BASE}/`);
    return response.data;
  } catch (error) {
    console.error('检查 Agent 健康状态失败:', error);
    throw error;
  }
};

export default {
  getFloodImages,
  getFloodImpact,
  checkGEEStatus,
  checkAgentHealth,
};
