import React, { createContext, useContext, useState, useCallback } from 'react';
import { buildAoiFromAgentState } from '../utils/aoi';

const AppContext = createContext();

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

// FloodAgent 默认状态
const defaultFloodAgentState = {
  event: null,
  event_description: null,
  flood_report: null,
  report_document: null,
  pre_date: null,
  after_date: null,
  peek_date: null,
  location: null,
  coordinates: null,
  bounds: null,
  geojson: null,
  search_sources: null,
  is_valid_flood_query: false,
};

const defaultAgentLayerVisibility = {
  agentSelectedPeriod: 'peek_date',
  agentSelectedType: 'sentinel2',
  agentShowFloodDetection: true,
  agentShowPopulationLayer: false,
  agentShowUrbanLayer: false,
  agentShowLandcoverLayer: false,
};

export const AppProvider = ({ children }) => {
  // UI State
  const [isPanelVisible, setIsPanelVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [warning, setWarning] = useState('');
  
  // 模式切换: 'ask' 或 'agent'
  const [appMode, setAppMode] = useState('ask');
  
  // ChatBox 模式切换 (与 appMode 同步)
  const [chatMode, setChatMode] = useState('ask');
  
  // Modal State
  const [activeModal, setActiveModal] = useState('welcome'); // 'welcome', 'prompt', '3d', 'error', 'contact', 'help', null
  
  // Map State
  const [mapInstance, setMapInstance] = useState(null);
  const [selectedGridCords, setSelectedGridCords] = useState(null);
  const [selectedAOI, setSelectedAOI] = useState(null);
  const [draftAOI, setDraftAOI] = useState(null);
  const [aoiEditorMode, setAoiEditorMode] = useState('idle');
  const [aoiClearVersion, setAoiClearVersion] = useState(0);
  const [countries, setCountries] = useState({});
  const [gridClickEnabled, setGridClickEnabled] = useState(true);
  
  // Layer State
  const [dataType, setDataType] = useState('historical'); // 'historical', 'floodHotspot', 'waterRegimeChange'
  const [yearControl, setYearControl] = useState(5);
  const [is3DEnabled, setIs3DEnabled] = useState(false);
  const [isBuildingsEnabled, setIsBuildingsEnabled] = useState(false);
  
  // Layer Visibility
  const [layerVisibility, setLayerVisibility] = useState({
    flood: true,
    water: true,
    regimeChange: true,
    seasonality: false,
    lclu: false,
    populationDensity: false,
    soilTexture: false,
    healthCareAccess: false,
  });
  
  // Layer Opacity
  const [layerOpacity, setLayerOpacity] = useState({
    flood: 1,
    water: 1,
    regimeChange: 1,
    seasonality: 1,
    lclu: 1,
    populationDensity: 1,
    soilTexture: 1,
    healthCareAccess: 1,
  });
  
  // Chat/GPT State
  const [chatInput, setChatInput] = useState('');
  const [gptResponse, setGptResponse] = useState(null);
  const [resultText, setResultText] = useState('');
  const [isResultVisible, setIsResultVisible] = useState(true);
  
  // Map Layer Data (EE responses)
  const [layerData, setLayerData] = useState({
    water: null,
    flood: null,
    regimeChange: null,
    seasonality: null,
    lclu: null,
    populationDensity: null,
    soilTexture: null,
    healthCareAccess: null,
  });
  
  // GEE Code Download
  const [geeCodeUrl, setGeeCodeUrl] = useState(null);
  
  // ========== FloodAgent 状态 (智能体模式) ==========
  const [floodAgentState, setFloodAgentState] = useState(defaultFloodAgentState);
  
  // FloodAgent 影像图层数据
  const [agentImagery, setAgentImagery] = useState(null);
  const [agentImageryLoading, setAgentImageryLoading] = useState(false);
  
  // ========== Agent Mode Control States ==========
  const [agentSelectedPeriod, setAgentSelectedPeriod] = useState('peek_date'); // 'pre_date' | 'peek_date' | 'after_date'
  const [agentSelectedType, setAgentSelectedType] = useState('sentinel2'); // 'sentinel2' | 'sentinel1'
  const [agentShowFloodDetection, setAgentShowFloodDetection] = useState(true);
  const [agentShowPopulationLayer, setAgentShowPopulationLayer] = useState(false);
  const [agentShowUrbanLayer, setAgentShowUrbanLayer] = useState(false);
  const [agentShowLandcoverLayer, setAgentShowLandcoverLayer] = useState(false);
  const [agentImpactData, setAgentImpactData] = useState(null);
  const [agentImpactLoading, setAgentImpactLoading] = useState(false);
  const [agentTileLoading, setAgentTileLoading] = useState(false);
  // Per-layer loading tracking: { 'base-imagery': bool, 'flood-detection': bool, 'population': bool, 'urban': bool, 'landcover': bool }
  const [agentLayerLoading, setAgentLayerLoading] = useState({});
  const [agentTileError, setAgentTileError] = useState(null); // tracks GEE tile load failures
  
  // 更新 FloodAgent 单个字段
  const updateFloodAgentField = useCallback((field, value) => {
    setFloodAgentState(prev => ({
      ...prev,
      [field]: value,
    }));
  }, []);
  
  // 重置 FloodAgent 状态
  const resetFloodAgentState = useCallback(() => {
    setFloodAgentState(defaultFloodAgentState);
    setAgentImagery(null);
  }, []);

  const resetAgentSession = useCallback(({ preserveSelectedAoi = true } = {}) => {
    setFloodAgentState(defaultFloodAgentState);
    setAgentImagery(null);
    setAgentImageryLoading(false);
    setAgentImpactData(null);
    setAgentImpactLoading(false);
    setAgentTileLoading(false);
    setAgentLayerLoading({});
    setAgentTileError(null);
    setAgentSelectedPeriod(defaultAgentLayerVisibility.agentSelectedPeriod);
    setAgentSelectedType(defaultAgentLayerVisibility.agentSelectedType);
    setAgentShowFloodDetection(defaultAgentLayerVisibility.agentShowFloodDetection);
    setAgentShowPopulationLayer(defaultAgentLayerVisibility.agentShowPopulationLayer);
    setAgentShowUrbanLayer(defaultAgentLayerVisibility.agentShowUrbanLayer);
    setAgentShowLandcoverLayer(defaultAgentLayerVisibility.agentShowLandcoverLayer);

    if (!preserveSelectedAoi) {
      setSelectedAOI(null);
      setSelectedGridCords(null);
    }
  }, []);
  
  // Toggle layer visibility
  const toggleLayerVisibility = useCallback((layerName) => {
    setLayerVisibility(prev => ({
      ...prev,
      [layerName]: !prev[layerName]
    }));
  }, []);
  
  // Update layer opacity
  const updateLayerOpacity = useCallback((layerName, opacity) => {
    setLayerOpacity(prev => ({
      ...prev,
      [layerName]: opacity
    }));
  }, []);
  
  // Reset all layer opacities
  const resetAllOpacity = useCallback(() => {
    setLayerOpacity({
      flood: 1,
      water: 1,
      regimeChange: 1,
      seasonality: 1,
      lclu: 1,
      populationDensity: 1,
      soilTexture: 1,
      healthCareAccess: 1,
    });
  }, []);
  
  // Update layer data from API response
  const updateLayerData = useCallback((data) => {
    setLayerData({
      regimeChange: data.eeMapURLRegimeChange ? {
        mapId: data.eeMapIdRegimeChange,
        token: data.eeTokenRegimeChange,
        tileUrl: data.eeMapURLRegimeChange
      } : null,
      seasonality: data.eeMapURLSeasonality ? {
        mapId: data.eeMapIdSeasonality,
        token: data.eeTokenSeasonality,
        tileUrl: data.eeMapURLSeasonality
      } : null,
      water: data.eeMapURLWater ? { 
        mapId: data.eeMapIdWater, 
        token: data.eeTokenWater, 
        tileUrl: data.eeMapURLWater 
      } : null,
      flood: data.eeMapURLFlood ? { 
        mapId: data.eeMapIdFlood, 
        token: data.eeTokenFlood, 
        tileUrl: data.eeMapURLFlood 
      } : null,
      lclu: data.eeMapURLLCLU ? { 
        mapId: data.eeMapIdLCLU, 
        token: data.eeTokenLCLU, 
        tileUrl: data.eeMapURLLCLU 
      } : null,
      populationDensity: data.eeMapURLPopulationDensity ? { 
        mapId: data.eeMapIdPopulationDensity, 
        token: data.eeTokenPopulationDensity, 
        tileUrl: data.eeMapURLPopulationDensity 
      } : null,
      soilTexture: data.eeMapURLSoilTexture ? { 
        mapId: data.eeMapIdSoilTexture, 
        token: data.eeTokenSoilTexture, 
        tileUrl: data.eeMapURLSoilTexture 
      } : null,
      healthCareAccess: data.eeMapURLHealthCareAccess ? { 
        mapId: data.eeMapIdHealthCareAccess, 
        token: data.eeTokenHealthCareAccess, 
        tileUrl: data.eeMapURLHealthCareAccess 
      } : null,
    });
  }, []);

  const resetAskSession = useCallback(() => {
    setGptResponse(null);
    setResultText('');
    setIsResultVisible(true);
    setWarning('');
    setLayerData({
      seasonality: null,
      water: null,
      flood: null,
      regimeChange: null,
      lclu: null,
      populationDensity: null,
      soilTexture: null,
      healthCareAccess: null,
    });
    setGeeCodeUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
  }, []);

  const cancelDraftAoi = useCallback(() => {
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
  }, []);

  const startAoiDraw = useCallback(() => {
    setDraftAOI(null);
    setAoiEditorMode('draw');
    setWarning('');
  }, []);

  const startAoiEdit = useCallback(() => {
    const editableAoi = selectedAOI || buildAoiFromAgentState(floodAgentState, {
      source: 'agent_geocode',
      label: floodAgentState?.location || 'Agent-derived boundary',
    });

    if (!editableAoi) {
      setWarning('请先通过鱼网、上传文件或 Agent 分析获得一个边界。');
      return false;
    }

    if (editableAoi.kind === 'multipolygon') {
      setWarning('当前边界是 MultiPolygon，第一版暂不支持直接编辑。请重新绘制一个单 Polygon。');
      return false;
    }

    setDraftAOI(editableAoi);
    setAoiEditorMode('edit');
    setWarning('');
    return true;
  }, [floodAgentState, selectedAOI]);

  const applyDraftAoi = useCallback(() => {
    if (!draftAOI?.geojson) {
      setWarning('请先绘制或编辑出一个有效的 Polygon 边界。');
      return false;
    }

      const nextAoi = JSON.parse(JSON.stringify(draftAOI));
      resetAskSession();
      setSelectedGridCords(null);
      setSelectedAOI(nextAoi);
    resetAgentSession({ preserveSelectedAoi: true });
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
    return true;
  }, [draftAOI, resetAgentSession, resetAskSession]);

  const clearAoiState = useCallback(() => {
    resetAskSession();
    resetAgentSession({ preserveSelectedAoi: false });
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setSelectedGridCords(null);
    setSelectedAOI(null);
    setWarning('');
    setAoiClearVersion((value) => value + 1);
  }, [resetAgentSession, resetAskSession]);

  const isAoiEditing = aoiEditorMode !== 'idle';

  const value = {
    // UI State
    isPanelVisible,
    setIsPanelVisible,
    isLoading,
    setIsLoading,
    warning,
    setWarning,
    
    // Modal State
    activeModal,
    setActiveModal,
    
    // Map State
    mapInstance,
    setMapInstance,
    selectedGridCords,
    setSelectedGridCords,
    selectedAOI,
    setSelectedAOI,
    draftAOI,
    setDraftAOI,
    aoiEditorMode,
    setAoiEditorMode,
    aoiClearVersion,
    isAoiEditing,
    startAoiDraw,
    startAoiEdit,
    applyDraftAoi,
    cancelDraftAoi,
    clearAoiState,
    countries,
    setCountries,
    gridClickEnabled,
    setGridClickEnabled,
    
    // Layer State
    dataType,
    setDataType,
    yearControl,
    setYearControl,
    is3DEnabled,
    setIs3DEnabled,
    isBuildingsEnabled,
    setIsBuildingsEnabled,
    
    // Layer Visibility & Opacity
    layerVisibility,
    setLayerVisibility,
    toggleLayerVisibility,
    layerOpacity,
    updateLayerOpacity,
    resetAllOpacity,
    
    // Chat/GPT State
    chatInput,
    setChatInput,
    gptResponse,
    setGptResponse,
    resultText,
    setResultText,
    isResultVisible,
    setIsResultVisible,
    
    // Map Layer Data
    layerData,
    updateLayerData,
    resetAskSession,
    
    // GEE Code
    geeCodeUrl,
    setGeeCodeUrl,
    
    // App Mode (ask/agent)
    appMode,
    setAppMode,
    chatMode,
    setChatMode,
    
    // FloodAgent State
    floodAgentState,
    setFloodAgentState,
    updateFloodAgentField,
    resetFloodAgentState,
    resetAgentSession,
    agentImagery,
    setAgentImagery,
    agentImageryLoading,
    setAgentImageryLoading,
    
    // Agent Mode Controls
    agentSelectedPeriod,
    setAgentSelectedPeriod,
    agentSelectedType,
    setAgentSelectedType,
    agentShowFloodDetection,
    setAgentShowFloodDetection,
    agentShowPopulationLayer,
    setAgentShowPopulationLayer,
    agentShowUrbanLayer,
    setAgentShowUrbanLayer,
    agentShowLandcoverLayer,
    setAgentShowLandcoverLayer,
    agentImpactData,
    setAgentImpactData,
    agentImpactLoading,
    setAgentImpactLoading,
    agentTileLoading,
    setAgentTileLoading,
    agentLayerLoading,
    setAgentLayerLoading,
    agentTileError,
    setAgentTileError,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
