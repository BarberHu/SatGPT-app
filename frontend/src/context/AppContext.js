import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { buildAoiFromAgentState } from '../utils/aoi';
import {
  buildBusinessLayerRecordFromAoi,
  buildAoiFromBusinessLayerRecord,
  createAgentSessionId,
  getStoredAgentSessionId,
  isBusinessLayerAoiSource,
  listBusinessLayerRecords,
  persistAgentSessionId,
  saveBusinessLayerRecords,
} from '../utils/businessLayerStore';
import { syncBusinessLayers } from '../services/agentApi';
import {
  buildDefaultAgentLayerOrder,
  buildDefaultAgentRasterLayerVisibility,
} from '../config/agentRasterLayerConfig';

const AppContext = createContext();

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

// Flood Agent 共享状态的默认结构，覆盖事件、AOI、推荐图层等上下文。
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
  resolved_aoi: null,
  aoi_resolution_meta: null,
  confirmed_aoi: null,
  recommended_layers: [],
  selected_layer_ids: [],
  recommendation_strategy: null,
  recommendation_source: null,
  confirmation_version: 0,
  search_sources: null,
  is_valid_flood_query: false,
};

const defaultAgentLayerVisibility = {
  agentSelectedPeriod: 'peek_date',
  agentSelectedType: 'sentinel2',
  agentShowBaseImagery: false,
  agentShowFloodDetection: false,
  agentShowPopulationLayer: false,
  agentShowUrbanLayer: false,
  agentShowLandcoverLayer: false,
};

const defaultAgentBaseImageryVisibility = {
  sentinel2: false,
  sentinel1: false,
};

const defaultAgentRasterLayerVisibility = buildDefaultAgentRasterLayerVisibility();
const defaultAgentLayerOrder = buildDefaultAgentLayerOrder();

const resolveCurrentBusinessScopeAoi = (records = [], selectedAoi = null) => {
  const activeRecord = (records || []).find((record) => record?.is_active) || null;
  if (activeRecord) {
    return buildAoiFromBusinessLayerRecord({
      ...activeRecord,
      is_active: true,
    });
  }

  if (selectedAoi?.id && isBusinessLayerAoiSource(selectedAoi?.source)) {
    return selectedAoi;
  }

  return null;
};

const activateBusinessLayer = (records = [], activeId = null) =>
  records.map((record) => ({
    ...record,
    is_active: Boolean(activeId && record.id === activeId),
    updated_at: new Date().toISOString(),
  }));

export const AppProvider = ({ children }) => {
  // UI State
  const [isPanelVisible, setIsPanelVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [warning, setWarning] = useState('');
  
  // 应用主模式：`ask` 表示传统问答流，`agent` 表示 Flood Agent 工作流。
  const [appMode, setAppMode] = useState('ask');
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = useState(false);
  const [agentModule, setAgentModule] = useState('flood');
  
  // ChatBox 独立维护的聊天模式，用于兼容 `appMode` 切换中的过渡状态。
  const [chatMode, setChatMode] = useState('ask');
  
  // Modal State
  const [activeModal, setActiveModal] = useState(null); // 'prompt', '3d', 'error', 'contact', 'help', null
  
  // Map State
  const [mapInstance, setMapInstance] = useState(null);
  const [selectedGridCords, setSelectedGridCords] = useState(null);
  const [selectedAOI, setSelectedAOI] = useState(null);
  const [draftAOI, setDraftAOI] = useState(null);
  const [aoiEditorMode, setAoiEditorMode] = useState('idle');
  const [aoiClearVersion, setAoiClearVersion] = useState(0);
  const [countries, setCountries] = useState({});
  const [gridClickEnabled, setGridClickEnabled] = useState(false);
  
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
    singleInundationEvent: null,
    inundationHotspot: null,
    wildfireRisk: null,
    landslideRisk: null,
    activeFireDetections: null,
    burnHistory: null,
    slopeSteepness: null,
    populationExposure: null,
    fuelLandCover: null,
    water: null,
    flood: null,
    lclu: null,
    populationDensity: null,
    soilTexture: null,
    healthCareAccess: null,
  });
  
  // GEE Code Download
  const [geeCodeUrl, setGeeCodeUrl] = useState(null);

  // Agent session + business layer inventory
  const [agentSessionId, setAgentSessionId] = useState(() => getStoredAgentSessionId());
  const [businessLayers, setBusinessLayers] = useState([]);
  const [businessLayersReady, setBusinessLayersReady] = useState(false);
  const [agentVisualResetVersion, setAgentVisualResetVersion] = useState(0);
  const selectedAOIRef = useRef(null);
  const previousAppModeRef = useRef('ask');
  
  // ========== Flood Agent 分析上下文（事件、时间、AOI、推荐图层） ==========
  const [floodAgentState, setFloodAgentState] = useState(defaultFloodAgentState);
  
  // Flood Agent 当前加载的影像结果，用于地图渲染与图层面板显示。
  const [agentImagery, setAgentImagery] = useState(null);
  const [agentImageryLoading, setAgentImageryLoading] = useState(false);
  
  // ========== Agent Mode Control States ==========
  const [agentSelectedPeriod, setAgentSelectedPeriod] = useState('peek_date'); // 'pre_date' | 'peek_date' | 'after_date'
  const [agentSelectedType, setAgentSelectedType] = useState('sentinel2'); // 'sentinel2' | 'sentinel1'
  const [agentShowBaseImagery, setAgentShowBaseImagery] = useState(false);
  const [agentBaseImageryVisibility, setAgentBaseImageryVisibility] = useState(defaultAgentBaseImageryVisibility);
  const [agentShowFloodDetection, setAgentShowFloodDetection] = useState(true);
  const [agentShowPopulationLayer, setAgentShowPopulationLayer] = useState(false);
  const [agentShowUrbanLayer, setAgentShowUrbanLayer] = useState(false);
  const [agentShowLandcoverLayer, setAgentShowLandcoverLayer] = useState(false);
  const [agentRasterLayerVisibility, setAgentRasterLayerVisibility] = useState(defaultAgentRasterLayerVisibility);
  const [agentRasterExpectedRequestKeys, setAgentRasterExpectedRequestKeys] = useState({});
  const [agentRasterLoading, setAgentRasterLoading] = useState(false);
  const [agentImpactData, setAgentImpactData] = useState(null);
  const [agentImpactLoading, setAgentImpactLoading] = useState(false);
  const [agentTileLoading, setAgentTileLoading] = useState(false);
  const [agentRecommendedLayerData, setAgentRecommendedLayerData] = useState({});
  const [agentRecommendedLayerVisibility, setAgentRecommendedLayerVisibility] = useState({});
  const [agentLayerOrder, setAgentLayerOrder] = useState(defaultAgentLayerOrder);
  // Per-layer loading tracking: { 'base-imagery': bool, 'flood-detection': bool, 'population': bool, 'urban': bool, 'landcover': bool }
  const [agentLayerLoading, setAgentLayerLoading] = useState({});
  const [agentTileError, setAgentTileError] = useState(null); // tracks GEE tile load failures
  
  // 更新 Flood Agent 单个字段，避免在组件里散落手写对象合并逻辑。
  const updateFloodAgentField = useCallback((field, value) => {
    setFloodAgentState(prev => ({
      ...prev,
      [field]: value,
    }));
  }, []);
  
  // 重置 Flood Agent 共享状态，并清空相关影像与推荐图层缓存。
  const resetFloodAgentState = useCallback(() => {
    setFloodAgentState(defaultFloodAgentState);
    setAgentImagery(null);
    setAgentRecommendedLayerData({});
    setAgentRecommendedLayerVisibility({});
    setAgentRasterLayerVisibility(buildDefaultAgentRasterLayerVisibility());
    setAgentRasterExpectedRequestKeys({});
    setAgentBaseImageryVisibility(defaultAgentBaseImageryVisibility);
    setAgentRasterLoading(false);
    setAgentLayerOrder(buildDefaultAgentLayerOrder());
  }, []);

  const clearAgentVisualState = useCallback(() => {
    setAgentImagery(null);
    setAgentImageryLoading(false);
    setAgentImpactData(null);
    setAgentImpactLoading(false);
    setAgentTileLoading(false);
    setAgentRecommendedLayerData({});
    setAgentRecommendedLayerVisibility({});
    setAgentRasterLayerVisibility(buildDefaultAgentRasterLayerVisibility());
    setAgentRasterExpectedRequestKeys({});
    setAgentBaseImageryVisibility(defaultAgentBaseImageryVisibility);
    setAgentRasterLoading(false);
    setAgentLayerOrder(buildDefaultAgentLayerOrder());
    setAgentLayerLoading({});
    setAgentTileError(null);
    setAgentShowBaseImagery(defaultAgentLayerVisibility.agentShowBaseImagery);
    setAgentShowFloodDetection(false);
    setAgentShowPopulationLayer(false);
    setAgentShowUrbanLayer(false);
    setAgentShowLandcoverLayer(false);
    setAgentVisualResetVersion((value) => value + 1);
  }, []);

  const setBusinessLayerActive = useCallback((activeLayerId) => {
    setBusinessLayers((previous) => {
      if (!previous.length) {
        return previous;
      }
      return activateBusinessLayer(previous, activeLayerId).map((record) => (
        activeLayerId && record.id === activeLayerId
          ? { ...record, is_visible: true }
          : record
      ));
    });
  }, []);

  const toggleBusinessLayerVisibility = useCallback((layerId) => {
    if (!layerId) {
      return;
    }

    setBusinessLayers((previous) => previous.map((record) => (
      record.id === layerId
        ? {
          ...record,
          is_visible: !(record.is_visible !== false),
          updated_at: new Date().toISOString(),
        }
        : record
    )));
  }, []);

  const fitAoiBoundsOnMap = useCallback((aoi, { padding = 64, duration = 700 } = {}) => {
    if (!mapInstance?.fitBounds || !aoi?.bounds) {
      return;
    }

    const { west, south, east, north } = aoi.bounds;
    mapInstance.fitBounds([[west, south], [east, north]], {
      padding,
      duration,
    });
  }, [mapInstance]);

  const upsertBusinessLayerRecord = useCallback((record, { markActive = true } = {}) => {
    if (!record?.id) {
      return null;
    }

    let nextRecord = null;
    setBusinessLayers((previous) => {
      const now = new Date().toISOString();
      const existing = previous.find((item) => item.id === record.id) || null;
      nextRecord = {
        ...existing,
        ...record,
        created_at: record.created_at || existing?.created_at || now,
        updated_at: record.updated_at || now,
        is_active: markActive ? true : Boolean(record.is_active ?? existing?.is_active),
      };

      const existingIndex = previous.findIndex((item) => item.id === record.id);
      const merged = existingIndex >= 0
        ? previous.map((item, index) => (index === existingIndex ? nextRecord : item))
        : [...previous, nextRecord];

      return markActive ? activateBusinessLayer(merged, nextRecord.id) : merged;
    });

    return nextRecord || record;
  }, []);

  const registerBusinessLayerFromAoi = useCallback((aoi, options = {}) => {
    const nextRecord = buildBusinessLayerRecordFromAoi(aoi, options);
    if (!nextRecord) {
      return null;
    }

    upsertBusinessLayerRecord(nextRecord, { markActive: options.markActive !== false });
    return nextRecord;
  }, [upsertBusinessLayerRecord]);

  const activateBusinessLayerRecord = useCallback((layerId, { focus = true } = {}) => {
    if (!layerId) {
      return null;
    }

    const targetRecord = businessLayers.find((record) => record.id === layerId);
    if (!targetRecord) {
      return null;
    }

    const nextAoi = buildAoiFromBusinessLayerRecord({
      ...targetRecord,
      is_active: true,
    });

    setBusinessLayerActive(layerId);
    if (nextAoi) {
      setSelectedAOI(nextAoi);
      setDraftAOI(null);
      setWarning('');
      if (focus) {
        window.requestAnimationFrame(() => {
          fitAoiBoundsOnMap(nextAoi, { padding: 72, duration: 650 });
        });
      }
    }

    return targetRecord;
  }, [
    businessLayers,
    fitAoiBoundsOnMap,
    setBusinessLayerActive,
  ]);

  const removeBusinessLayerRecord = useCallback((layerId, { nextSelectedAoi = null } = {}) => {
    if (!layerId) {
      return;
    }

    setBusinessLayers((previous) => {
      const remaining = previous.filter((item) => item.id !== layerId);
      if (!remaining.length) {
        return [];
      }

      if (nextSelectedAoi?.id) {
        return activateBusinessLayer(remaining, nextSelectedAoi.id).map((record) => (
          record.id === nextSelectedAoi.id
            ? { ...record, is_visible: true }
            : record
        ));
      }

      const activeCandidate = remaining.find((item) => item.is_active) || remaining[0];
      return activateBusinessLayer(remaining, activeCandidate?.id || null).map((record) => (
        activeCandidate?.id && record.id === activeCandidate.id
          ? { ...record, is_visible: true }
          : record
      ));
    });
  }, []);

  const deleteBusinessLayer = useCallback((layerId) => {
    if (!layerId) {
      return null;
    }

    const targetRecord = businessLayers.find((record) => record.id === layerId);
    if (!targetRecord) {
      return null;
    }

    const deletedActive = Boolean(targetRecord.is_active || selectedAOI?.id === layerId);
    const remainingRecords = businessLayers.filter((record) => record.id !== layerId);
    const fallbackRecord = deletedActive ? (remainingRecords[0] || null) : null;
    const fallbackAoi = fallbackRecord ? buildAoiFromBusinessLayerRecord({
      ...fallbackRecord,
      is_active: true,
    }) : null;

    if (deletedActive) {
      setSelectedAOI(fallbackAoi || null);
    }

    removeBusinessLayerRecord(layerId, { nextSelectedAoi: fallbackAoi });
    setWarning('');
    return {
      deleted: targetRecord,
      fallback: fallbackRecord,
    };
  }, [businessLayers, removeBusinessLayerRecord, selectedAOI]);

  const startNewAgentSession = useCallback(({ preserveSelectedAoi = true } = {}) => {
    const nextSessionId = createAgentSessionId();
    persistAgentSessionId(nextSessionId);
    setAgentSessionId(nextSessionId);

    const shouldSeedSelectedAoi = preserveSelectedAoi && isBusinessLayerAoiSource(selectedAOI?.source);
    const seededLayers = shouldSeedSelectedAoi
      ? [buildBusinessLayerRecordFromAoi(selectedAOI, {
          id: selectedAOI?.id,
          label: selectedAOI?.label,
          source: selectedAOI?.source,
          origin: selectedAOI?.origin || (selectedAOI?.source === 'draw' ? 'draw' : 'upload'),
          is_active: true,
        })].filter(Boolean)
      : [];

    setBusinessLayers(seededLayers);
    setBusinessLayersReady(false);
    saveBusinessLayerRecords(nextSessionId, seededLayers).catch((error) => {
      console.error('Failed to seed business layers for new agent session:', error);
    });

    if (!preserveSelectedAoi) {
      setSelectedAOI(null);
      setSelectedGridCords(null);
    }

    return nextSessionId;
  }, [selectedAOI]);

  const resetAgentSession = useCallback(({ preserveSelectedAoi = true } = {}) => {
    setFloodAgentState(defaultFloodAgentState);
    setAgentImagery(null);
    setAgentImageryLoading(false);
    setAgentImpactData(null);
    setAgentImpactLoading(false);
    setAgentTileLoading(false);
    setAgentRecommendedLayerData({});
    setAgentRecommendedLayerVisibility({});
    setAgentRasterLayerVisibility(buildDefaultAgentRasterLayerVisibility());
    setAgentRasterExpectedRequestKeys({});
    setAgentRasterLoading(false);
    setAgentLayerOrder(buildDefaultAgentLayerOrder());
    setAgentLayerLoading({});
    setAgentTileError(null);
    setAgentSelectedPeriod(defaultAgentLayerVisibility.agentSelectedPeriod);
    setAgentSelectedType(defaultAgentLayerVisibility.agentSelectedType);
    setAgentShowBaseImagery(defaultAgentLayerVisibility.agentShowBaseImagery);
    setAgentBaseImageryVisibility(defaultAgentBaseImageryVisibility);
    setAgentShowFloodDetection(defaultAgentLayerVisibility.agentShowFloodDetection);
    setAgentShowPopulationLayer(defaultAgentLayerVisibility.agentShowPopulationLayer);
    setAgentShowUrbanLayer(defaultAgentLayerVisibility.agentShowUrbanLayer);
    setAgentShowLandcoverLayer(defaultAgentLayerVisibility.agentShowLandcoverLayer);

    if (!preserveSelectedAoi) {
      setSelectedAOI(null);
      setSelectedGridCords(null);
    }
  }, []);

  useEffect(() => {
    selectedAOIRef.current = selectedAOI;
  }, [selectedAOI]);

  const resetAskSession = useCallback(() => {
    setGptResponse(null);
    setResultText('');
    setIsResultVisible(true);
    setWarning('');
    setLayerData({
      singleInundationEvent: null,
      inundationHotspot: null,
      wildfireRisk: null,
      landslideRisk: null,
      activeFireDetections: null,
      burnHistory: null,
      slopeSteepness: null,
      populationExposure: null,
      fuelLandCover: null,
      water: null,
      flood: null,
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

  useEffect(() => {
    const previousMode = previousAppModeRef.current;

    if (previousMode !== appMode) {
      if (String(selectedAOI?.source || '').toLowerCase() === 'fishnet') {
        resetAskSession();
        setSelectedGridCords(null);
        setSelectedAOI(null);
        setDraftAOI(null);
        setWarning('');
        previousAppModeRef.current = appMode;
        return;
      }
    }

    if (
      previousMode === 'ask'
      && appMode === 'agent'
    ) {
      resetAskSession();

      const nextScopeAoi = resolveCurrentBusinessScopeAoi(businessLayers, selectedAOI);

      if (
        nextScopeAoi
        && (
          !selectedAOI?.id
          || !isBusinessLayerAoiSource(selectedAOI?.source)
          || selectedAOI.id !== nextScopeAoi.id
        )
      ) {
        setSelectedAOI(nextScopeAoi);
        setDraftAOI(null);
        setWarning('');
      }
    }

    if (
      previousMode === 'agent'
      && appMode === 'ask'
    ) {
      resetAgentSession({ preserveSelectedAoi: true });
    }

    previousAppModeRef.current = appMode;
  }, [appMode, agentLayerOrder, businessLayers, resetAgentSession, resetAskSession, selectedAOI, setDraftAOI, setWarning]);

  useEffect(() => {
    let cancelled = false;
    setBusinessLayersReady(false);

    listBusinessLayerRecords(agentSessionId)
      .then((records) => {
        if (cancelled) {
          return;
        }
        const supportedRecords = (records || []).filter((record) => isBusinessLayerAoiSource(record?.source));
        const currentSelectedAoi = selectedAOIRef.current;
        const fallbackSelectedAoi = (!supportedRecords.length && currentSelectedAoi?.id && isBusinessLayerAoiSource(currentSelectedAoi?.source))
          ? [buildBusinessLayerRecordFromAoi(currentSelectedAoi, {
              id: currentSelectedAoi.id,
              label: currentSelectedAoi.label,
              source: currentSelectedAoi.source,
              origin: currentSelectedAoi.origin || (currentSelectedAoi.source === 'draw' ? 'draw' : 'upload'),
              is_active: true,
            })].filter(Boolean)
          : [];
        setBusinessLayers(supportedRecords.length ? supportedRecords : fallbackSelectedAoi);
        setBusinessLayersReady(true);
      })
      .catch((error) => {
        console.error('Failed to load business layers from IndexedDB:', error);
        if (cancelled) {
          return;
        }
        setBusinessLayers([]);
        setBusinessLayersReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [agentSessionId]);

  useEffect(() => {
    if (!businessLayersReady) {
      return;
    }

    saveBusinessLayerRecords(agentSessionId, businessLayers).catch((error) => {
      console.error('Failed to persist business layers to IndexedDB:', error);
    });

    syncBusinessLayers({
      store_key: agentSessionId,
      store_namespace: 'business_layer_store',
      layers: businessLayers,
    }).catch((error) => {
      console.error('Failed to sync business layers to backend cache:', error);
    });
  }, [agentSessionId, businessLayers, businessLayersReady]);

  useEffect(() => {
    if (!selectedAOI?.id || !isBusinessLayerAoiSource(selectedAOI?.source)) {
      return;
    }

    const existingLayer = businessLayers.find((record) => record.id === selectedAOI.id);
    const nextRecord = buildBusinessLayerRecordFromAoi(selectedAOI, {
      id: selectedAOI.id,
      label: selectedAOI.label,
      source: selectedAOI.source,
      origin: selectedAOI.origin || (selectedAOI.source === 'draw' ? 'draw' : 'upload'),
      is_active: true,
      created_at: existingLayer?.created_at || selectedAOI.created_at,
    });

    if (!nextRecord) {
      return;
    }

    const shouldSkipUpdate =
      existingLayer
      && existingLayer.is_active
      && JSON.stringify(existingLayer.bounds || null) === JSON.stringify(nextRecord.bounds || null)
      && JSON.stringify(existingLayer.geojson || null) === JSON.stringify(nextRecord.geojson || null)
      && existingLayer.label === nextRecord.label
      && existingLayer.source === nextRecord.source;

    if (shouldSkipUpdate) {
      return;
    }

    setBusinessLayers((previous) => {
      const existingIndex = previous.findIndex((item) => item.id === nextRecord.id);
      const merged = existingIndex >= 0
        ? previous.map((item, index) => (index === existingIndex ? {
          ...item,
          ...nextRecord,
          created_at: item.created_at || nextRecord.created_at,
        } : item))
        : [...previous, nextRecord];

      return activateBusinessLayer(merged, nextRecord.id);
    });
  }, [businessLayers, selectedAOI]);
  
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
    setLayerData(normalizeLayerData(data));
  }, []);

  const mergeLayerData = useCallback((data, options = {}) => {
    setLayerData((previous) => ({
      ...previous,
      ...normalizeLayerData(data, { partial: true, ...options }),
    }));
  }, []);

  function normalizeLayerData(data = {}, options = {}) {
    const { partial = false, aoiSignature = null, requestKey = null } = options;
    const normalized = {};
    const setLayer = (key, urlField, layerValue) => {
      if (!partial || Object.prototype.hasOwnProperty.call(data, urlField)) {
        normalized[key] = data[urlField]
          ? {
            ...layerValue,
            aoiSignature,
            requestKey,
          }
          : null;
      }
    };

    setLayer('singleInundationEvent', 'eeMapURLSingleInundationEvent', {
        mapId: data.eeMapIdSingleInundationEvent,
        token: data.eeTokenSingleInundationEvent,
        tileUrl: data.eeMapURLSingleInundationEvent,
        meta: data.singleInundationEventMeta || null,
    });
    setLayer('inundationHotspot', 'eeMapURLInundationHotspot', {
        mapId: data.eeMapIdInundationHotspot,
        token: data.eeTokenInundationHotspot,
        tileUrl: data.eeMapURLInundationHotspot,
        meta: data.inundationHotspotMeta || null,
    });
    setLayer('wildfireRisk', 'eeMapURLWildfireRisk', {
        mapId: data.eeMapIdWildfireRisk,
        token: data.eeTokenWildfireRisk,
        tileUrl: data.eeMapURLWildfireRisk,
        meta: data.wildfireRiskMeta || null,
    });
    setLayer('landslideRisk', 'eeMapURLLandslideRisk', {
        mapId: data.eeMapIdLandslideRisk,
        token: data.eeTokenLandslideRisk,
        tileUrl: data.eeMapURLLandslideRisk,
        meta: data.landslideRiskMeta || null,
    });
    setLayer('water', 'eeMapURLWater', {
        mapId: data.eeMapIdWater, 
        token: data.eeTokenWater, 
        tileUrl: data.eeMapURLWater 
    });
    setLayer('flood', 'eeMapURLFlood', {
        mapId: data.eeMapIdFlood, 
        token: data.eeTokenFlood, 
        tileUrl: data.eeMapURLFlood 
    });
    setLayer('lclu', 'eeMapURLLCLU', {
        mapId: data.eeMapIdLCLU, 
        token: data.eeTokenLCLU, 
        tileUrl: data.eeMapURLLCLU 
    });
    setLayer('populationDensity', 'eeMapURLPopulationDensity', {
        mapId: data.eeMapIdPopulationDensity, 
        token: data.eeTokenPopulationDensity, 
        tileUrl: data.eeMapURLPopulationDensity 
    });
    setLayer('soilTexture', 'eeMapURLSoilTexture', {
        mapId: data.eeMapIdSoilTexture, 
        token: data.eeTokenSoilTexture, 
        tileUrl: data.eeMapURLSoilTexture 
    });
    setLayer('activeFireDetections', 'eeMapURLActiveFireDetections', {
        mapId: data.eeMapIdActiveFireDetections,
        token: data.eeTokenActiveFireDetections,
        tileUrl: data.eeMapURLActiveFireDetections,
        meta: data.activeFireDetectionsMeta || null,
    });
    setLayer('burnHistory', 'eeMapURLBurnHistory', {
        mapId: data.eeMapIdBurnHistory,
        token: data.eeTokenBurnHistory,
        tileUrl: data.eeMapURLBurnHistory,
        meta: data.burnHistoryMeta || null,
    });
    setLayer('slopeSteepness', 'eeMapURLSlopeSteepness', {
        mapId: data.eeMapIdSlopeSteepness,
        token: data.eeTokenSlopeSteepness,
        tileUrl: data.eeMapURLSlopeSteepness,
        meta: data.slopeSteepnessMeta || null,
    });
    setLayer('populationExposure', 'eeMapURLPopulationExposure', {
        mapId: data.eeMapIdPopulationExposure,
        token: data.eeTokenPopulationExposure,
        tileUrl: data.eeMapURLPopulationExposure,
        meta: data.populationExposureMeta || null,
    });
    setLayer('fuelLandCover', 'eeMapURLFuelLandCover', {
        mapId: data.eeMapIdFuelLandCover,
        token: data.eeTokenFuelLandCover,
        tileUrl: data.eeMapURLFuelLandCover,
        meta: data.fuelLandCoverMeta || null,
    });
    setLayer('healthCareAccess', 'eeMapURLHealthCareAccess', {
        mapId: data.eeMapIdHealthCareAccess, 
        token: data.eeTokenHealthCareAccess, 
        tileUrl: data.eeMapURLHealthCareAccess 
    });

    return normalized;
  }

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
      label: floodAgentState?.location || 'Agent-derived scope',
    });

    if (!editableAoi) {
      setWarning('Please select, upload, or resolve a spatial scope before editing.');
      return false;
    }

    setDraftAOI(JSON.parse(JSON.stringify(editableAoi)));
    setAoiEditorMode('edit');
    setWarning('');
    return true;
  }, [floodAgentState, selectedAOI]);

  const applyDraftAoi = useCallback(() => {
    if (!draftAOI?.geojson) {
      setWarning('Please draw or edit a valid spatial scope before applying.');
      return false;
    }

    const nextAoi = JSON.parse(JSON.stringify(draftAOI));
    if (!isBusinessLayerAoiSource(nextAoi.source)) {
      nextAoi.source = aoiEditorMode === 'edit' ? 'edited' : 'draw';
      nextAoi.origin = aoiEditorMode === 'edit' ? 'draw' : 'draw';
      if (nextAoi.geojson?.properties) {
        nextAoi.geojson.properties.source = nextAoi.source;
      }
    }
    resetAskSession();
    setSelectedGridCords(null);
    setSelectedAOI(nextAoi);
    registerBusinessLayerFromAoi(nextAoi, {
      id: nextAoi.id,
      label: nextAoi.label,
      source: nextAoi.source,
      origin: nextAoi.source === 'draw' || nextAoi.source === 'edited' ? 'draw' : 'upload',
      markActive: true,
    });
    resetAgentSession({ preserveSelectedAoi: true });
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
    return nextAoi;
  }, [aoiEditorMode, draftAOI, registerBusinessLayerFromAoi, resetAgentSession, resetAskSession]);

  const clearAoiState = useCallback(() => {
    resetAskSession();
    resetAgentSession({ preserveSelectedAoi: false });
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setSelectedGridCords(null);
    setSelectedAOI(null);
    setBusinessLayerActive(null);
    setWarning('');
    setAoiClearVersion((value) => value + 1);
  }, [resetAgentSession, resetAskSession, setBusinessLayerActive]);

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
    mergeLayerData,
    resetAskSession,
    
    // GEE Code
    geeCodeUrl,
    setGeeCodeUrl,

    // Agent session + business layer inventory
    agentSessionId,
    businessLayers,
    businessLayersReady,
    agentVisualResetVersion,
    setBusinessLayers,
    setBusinessLayerActive,
    toggleBusinessLayerVisibility,
    activateBusinessLayerRecord,
    fitAoiBoundsOnMap,
    upsertBusinessLayerRecord,
    registerBusinessLayerFromAoi,
    removeBusinessLayerRecord,
    deleteBusinessLayer,
    startNewAgentSession,
    clearAgentVisualState,

    // App Mode (ask/agent)
    appMode,
    setAppMode,
    agentSidebarCollapsed,
    setAgentSidebarCollapsed,
    agentModule,
    setAgentModule,
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
    agentShowBaseImagery,
    setAgentShowBaseImagery,
    agentBaseImageryVisibility,
    setAgentBaseImageryVisibility,
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
    agentRecommendedLayerData,
    setAgentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    setAgentRecommendedLayerVisibility,
    agentRasterLayerVisibility,
    setAgentRasterLayerVisibility,
    agentRasterExpectedRequestKeys,
    setAgentRasterExpectedRequestKeys,
    agentRasterLoading,
    setAgentRasterLoading,
    agentLayerOrder,
    setAgentLayerOrder,
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
