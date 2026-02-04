import React, { createContext, useContext, useState, useCallback } from 'react';

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
  const [countries, setCountries] = useState({});
  
  // Layer State
  const [dataType, setDataType] = useState('historical'); // 'historical', 'floodHotspot'
  const [yearControl, setYearControl] = useState(5);
  const [is3DEnabled, setIs3DEnabled] = useState(false);
  const [isBuildingsEnabled, setIsBuildingsEnabled] = useState(false);
  
  // Layer Visibility
  const [layerVisibility, setLayerVisibility] = useState({
    flood: true,
    water: true,
    lclu: false,
    populationDensity: false,
    soilTexture: false,
    healthCareAccess: false,
  });
  
  // Layer Opacity
  const [layerOpacity, setLayerOpacity] = useState({
    flood: 1,
    water: 1,
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
      lclu: 1,
      populationDensity: 1,
      soilTexture: 1,
      healthCareAccess: 1,
    });
  }, []);
  
  // Update layer data from API response
  const updateLayerData = useCallback((data) => {
    setLayerData({
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
    countries,
    setCountries,
    
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
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
