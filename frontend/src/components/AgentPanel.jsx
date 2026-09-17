/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { Profiler, startTransition, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useCoAgent, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import AgentGeeCodeDownload from './AgentGeeCodeDownload';
import EventConfirmation from './EventConfirmation';
import LayerManager from './LayerManager';
import { getFloodLayerCatalog } from '../services/agentApi';
import useAgentRasterDownload from '../hooks/useAgentRasterDownload';
import useAgentLayerManagerGroups, {
  DEFAULT_HOTSPOT_YEAR_RANGE,
  getYearRangeCount,
  isValidDateWindow,
  normalizeYearRange,
  resolveCatalogLayerDateWindow,
  resolveSingleInundationDateWindow,
} from '../hooks/useAgentLayerManagerGroups';
import useAgentRasterLayerRequest from '../hooks/useAgentRasterLayerRequest';
import useFloodAnalysisRequests from '../hooks/useFloodAnalysisRequests';
import useFloodAgentStateAdapter, {
  areAoiScopesEquivalent,
  buildLayerSignature,
  buildRecommendedLayerContextKey,
} from '../hooks/useFloodAgentStateAdapter';
import useRecommendedLayerRenderer from '../hooks/useRecommendedLayerRenderer';
import {
  buildAoiFromAgentState,
  buildAoiSignature,
  buildAskMapRequestParams,
  resolveAgentAnalysisAoi,
} from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import { getCatalogMapLayerId, sortCatalogLayers } from '../utils/catalogLayers';
import { buildCatalogLayerContextKey } from '../utils/catalogLayerContext';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import { FLOOD_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';
import { DEFAULT_FLOOD_AGENT_STATE } from '../config/floodAgentState';
import {
  createReactProfilerHandler,
  updateAgentDiagnosticsContext,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
import 'rc-slider/assets/index.css';
import './AgentPanel.css';

const EMPTY_ARRAY = [];
function AgentPanel() {
  const { 
    setAgentAnalysisContext,
    agentAnalysisContext,
    setWarning,
    setAgentImagery,
    setAgentImageryLoading,
    agentImagery,
    agentImageryLoading,
    // Agent control states from context
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
    layerData,
    agentRecommendedLayerData,
    setAgentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    setAgentRecommendedLayerVisibility,
    agentRasterLayerVisibility,
    setAgentRasterLayerVisibility,
    agentLayerOrder,
    setAgentLayerOrder,
    agentLayerLoading,
    setAgentLayerLoading,
    agentLayerProgress,
    setAgentTileError,
    mergeLayerData,
    mapInstance,
    selectedAOI,
  } = useAppContext();

  const [hotspotYearRange, setHotspotYearRange] = useState(DEFAULT_HOTSPOT_YEAR_RANGE);
  const [singleInundationTimeWindow, setSingleInundationTimeWindow] = useState({});
  const [catalogLayerTimeOverrides, setCatalogLayerTimeOverrides] = useState({});
  const [defaultCatalogLayers, setDefaultCatalogLayers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    getFloodLayerCatalog({ signal: controller.signal })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const layers = result?.data?.recommended_layers || [];
        setDefaultCatalogLayers(sortCatalogLayers(
          layers.filter((layer) => layer.layer_family === 'catalog')
        ));
      })
      .catch((error) => {
        if (!cancelled && !error?.isCanceled) {
          console.error('Flood layer catalog initialization failed:', error);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const { state } = useCoAgent({
    name: "flood_agent",
    initialState: DEFAULT_FLOOD_AGENT_STATE,
  });

  const previousSelectedAoiSignatureRef = useRef('no-aoi');
  const {
    currentState,
    hasCoAgentState,
    viewState: sharedAgentState,
  } = useFloodAgentStateAdapter({ state, fallbackState: agentAnalysisContext });

  useEffect(() => {
    if (hasCoAgentState) {
      startTransition(() => {
        setAgentAnalysisContext(sharedAgentState);
      });
    }
  }, [hasCoAgentState, setAgentAnalysisContext, sharedAgentState]);

  const currentConfirmedAoi = currentState?.confirmed_aoi || null;
  const currentResolvedAoi = currentState?.resolved_aoi || null;
  const currentLocation = currentState?.location || null;
  const currentBounds = currentState?.bounds || null;
  const currentGeojson = currentState?.geojson || null;
  const currentConfirmationVersion = currentState?.confirmation_version || 0;
  const currentCoordinates = currentState?.coordinates || null;
  const currentPreDate = currentState?.pre_date || null;
  const currentPeekDate = currentState?.peek_date || null;
  const currentAfterDate = currentState?.after_date || null;
  const currentRecommendedLayers = currentState?.recommended_layers || EMPTY_ARRAY;
  const currentSelectedLayerIds = currentState?.selected_layer_ids || EMPTY_ARRAY;
  const currentGeeCode = currentState?.gee_code || null;
  const currentEvent = currentState?.event || null;
  const currentRecommendedLayerSignature = buildLayerSignature(currentRecommendedLayers);
  const agentDerivedAoi = useMemo(() => buildAoiFromAgentState({
    confirmed_aoi: currentConfirmedAoi,
    resolved_aoi: currentResolvedAoi,
    geojson: currentGeojson,
    bounds: currentBounds,
    location: currentLocation,
  }, {
    source: 'agent_geocode',
    label: currentLocation || 'Agent-derived scope',
  }), [
    currentConfirmedAoi,
    currentResolvedAoi,
    currentGeojson,
    currentBounds,
    currentLocation,
  ]);
  const selectedBusinessScope = isBusinessLayerAoiSource(selectedAOI?.source) ? selectedAOI : null;
  const analysisScopeMatchesSelection = selectedBusinessScope
    ? areAoiScopesEquivalent(selectedBusinessScope, agentDerivedAoi)
    : true;
  const hasResolvedAnalysisContext = Boolean(
    currentEvent
    && currentPreDate
    && currentPeekDate
    && currentAfterDate
    && (agentDerivedAoi || currentCoordinates)
  );
  const analysisDisplayEnabled = hasResolvedAnalysisContext && analysisScopeMatchesSelection;
  const effectiveAoi = analysisDisplayEnabled ? agentDerivedAoi : null;
  const activeAnalysisAoi = useMemo(
    () => resolveAgentAnalysisAoi(
      selectedBusinessScope,
      effectiveAoi,
      selectedAOI,
      agentDerivedAoi
    ),
    [agentDerivedAoi, effectiveAoi, selectedAOI, selectedBusinessScope]
  );
  const {
    downloadState: rasterDownloadState,
    downloadRaster: handleAgentRasterDownload,
  } = useAgentRasterDownload({ aoi: activeAnalysisAoi, setWarning });
  const catalogRenderAoi = activeAnalysisAoi;
  const catalogRenderAoiSignature = useMemo(
    () => buildAoiSignature(catalogRenderAoi, currentBounds),
    [catalogRenderAoi, currentBounds]
  );
  const getCatalogLayerDateWindow = useCallback((layer) => resolveCatalogLayerDateWindow(
    layer,
    catalogLayerTimeOverrides?.[layer?.id] || {},
    { currentPreDate, currentPeekDate, currentAfterDate }
  ), [catalogLayerTimeOverrides, currentAfterDate, currentPeekDate, currentPreDate]);
  const canRenderCatalogLayer = useCallback((layer) => {
    const requiresDateRange = layer?.execution_profile?.requires_date_range !== false;
    const dateWindow = getCatalogLayerDateWindow(layer);
    return Boolean(catalogRenderAoi) && (!requiresDateRange || isValidDateWindow(dateWindow));
  }, [catalogRenderAoi, getCatalogLayerDateWindow]);
  const selectedAoiSignature = useMemo(
    () => buildAoiSignature(activeAnalysisAoi),
    [activeAnalysisAoi]
  );

  const requestAgentRasterLayer = useAgentRasterLayerRequest({
    aoiSignature: selectedAoiSignature,
    mergeLayerData,
    setAgentLayerLoading,
    setWarning,
  });

  useEffect(() => {
    const previousSignature = previousSelectedAoiSignatureRef.current;
    previousSelectedAoiSignatureRef.current = selectedAoiSignature;

    if (previousSignature === selectedAoiSignature) {
      return;
    }

    setAgentRasterLayerVisibility((previous) => {
      const next = { ...previous };
      FLOOD_RASTER_LAYER_CONFIG.forEach((layer) => {
        next[layer.key] = false;
      });
      return next;
    });
    setAgentLayerLoading((previous) => {
      const next = { ...previous };
      FLOOD_RASTER_LAYER_CONFIG.forEach((layer) => {
        next[`raster-${layer.key}`] = false;
      });
      return next;
    });
  }, [
    selectedAoiSignature,
    setAgentLayerLoading,
    setAgentRasterLayerVisibility,
  ]);

  const buildAgentRasterRequestParams = useCallback((layerKey, overrides = {}) => {
    if (!activeAnalysisAoi) {
      return null;
    }

    const singleEventWindow = resolveSingleInundationDateWindow(
      singleInundationTimeWindow,
      { currentPreDate, currentPeekDate, currentAfterDate }
    );
    const baseParams = buildAskMapRequestParams(activeAnalysisAoi, {
      time_start: layerKey === 'singleInundationEvent'
        ? (overrides.time_start || singleEventWindow.start_date)
        : (currentPreDate || '2010-01-01'),
      time_end: layerKey === 'singleInundationEvent'
        ? (overrides.time_end || singleEventWindow.end_date)
        : (currentAfterDate || currentPeekDate || '2024-12-31'),
      cloud_mask: 'true',
      climatology: 'false',
      month_from: '1',
      month_to: '12',
      layer_keys: [layerKey],
      ...overrides,
    });

    if (layerKey === 'inundationHotspot') {
      const [yearStart, yearEnd] = normalizeYearRange(
        overrides.year_start ?? overrides.year_from ?? hotspotYearRange[0],
        overrides.year_end ?? (
          overrides.year_count
            ? Number(overrides.year_from ?? hotspotYearRange[0]) + Number(overrides.year_count) - 1
            : hotspotYearRange[1]
        ),
        hotspotYearRange
      );
      baseParams.year_start = yearStart;
      baseParams.year_end = yearEnd;
      baseParams.year_from = yearStart;
      baseParams.year_count = getYearRangeCount([yearStart, yearEnd]);
    }

    return baseParams;
  }, [activeAnalysisAoi, currentAfterDate, currentPeekDate, currentPreDate, hotspotYearRange, singleInundationTimeWindow]);

  const fetchAgentRasterLayer = useCallback(async (layerKey, overrides = {}) => {
    const params = buildAgentRasterRequestParams(layerKey, overrides);
    if (!params) {
      setWarning('Please select an AOI before loading raster data.');
      return;
    }

    const requestKey = [
      layerKey,
      selectedAoiSignature,
      params.time_start || '',
      params.time_end || '',
      params.year_start || '',
      params.year_end || '',
      params.year_from || '',
      params.year_count || '',
    ].join('|');

    await requestAgentRasterLayer({
      layerKey,
      params,
      requestKey,
      errorMessage: 'Raster layer request failed.',
    });
  }, [
    buildAgentRasterRequestParams,
    requestAgentRasterLayer,
    selectedAoiSignature,
    setWarning,
  ]);

  const downloadableGeeCode = currentGeeCode;
  const geeCodeDisabledReason = !currentGeeCode
    ? (hasResolvedAnalysisContext
      ? 'GEE code will become available once the flood report completes. Confirm the event and let the agent finish generating the report.'
      : 'Resolve event dates and AOI, then complete the analysis to enable GEE code download.')
    : null;
  const recommendedCatalogLayers = useMemo(
    () => sortCatalogLayers(
      currentRecommendedLayers.filter((layer) => layer.layer_family === 'catalog')
    ),
    [currentRecommendedLayers]
  );
  const controlPanelCatalogLayers = recommendedCatalogLayers.length
    ? recommendedCatalogLayers
    : defaultCatalogLayers;
  const controlPanelCatalogLayerSignature = buildLayerSignature(controlPanelCatalogLayers);
  const effectiveAoiSignature = buildAoiSignature(effectiveAoi, currentBounds);
  const recommendedLayerBaseContextKey = useMemo(() => buildRecommendedLayerContextKey({
    confirmationVersion: currentConfirmationVersion,
    preDate: currentPreDate,
    peekDate: currentPeekDate,
    afterDate: currentAfterDate,
    aoiSignature: catalogRenderAoiSignature,
    layerSignature: controlPanelCatalogLayerSignature,
    timeOverrideSignature: 'per-layer-time',
  }), [
    currentConfirmationVersion,
    currentPreDate,
    currentPeekDate,
    currentAfterDate,
    controlPanelCatalogLayerSignature,
    catalogRenderAoiSignature,
  ]);
  const getRecommendedLayerContextKey = useCallback((layer) => buildCatalogLayerContextKey({
    baseContextKey: recommendedLayerBaseContextKey,
    layer,
    dateWindow: getCatalogLayerDateWindow(layer),
  }), [getCatalogLayerDateWindow, recommendedLayerBaseContextKey]);
  useFloodAnalysisRequests({
    analysisDisplayEnabled,
    currentAfterDate,
    currentBounds,
    currentCoordinates,
    currentGeojson,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
    effectiveAoiSignature,
    impactLayerVisible: agentShowPopulationLayer || agentShowUrbanLayer || agentShowLandcoverLayer,
    agentImpactData,
    agentImpactLoading,
    setAgentImagery,
    setAgentImageryLoading,
    setAgentImpactData,
    setAgentImpactLoading,
    setAgentTileError,
    setWarning,
  });
  useRecommendedLayerRenderer({
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    canRenderCatalogLayer,
    catalogRenderAoi,
    controlPanelCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    getCatalogLayerDateWindow,
    getRecommendedLayerContextKey,
    recommendedLayerBaseContextKey,
    setAgentLayerLoading,
    setAgentRecommendedLayerData,
    setWarning,
  });
  const panelProfiler = useMemo(
    () => createReactProfilerHandler('AgentPanel', () => ({
      analysisDisplayEnabled,
      confirmationVersion: currentConfirmationVersion,
      effectiveAoiSignature,
      recommendedLayerCount: currentRecommendedLayers.length,
      selectedLayerCount: currentSelectedLayerIds.length,
      imageryLoading: agentImageryLoading,
      impactLoading: agentImpactLoading,
    })),
    [
      agentImpactLoading,
      agentImageryLoading,
      analysisDisplayEnabled,
      currentConfirmationVersion,
      currentRecommendedLayers.length,
      currentSelectedLayerIds.length,
      effectiveAoiSignature,
    ]
  );

  useRenderDiagnostics('AgentPanel', () => ({
    analysisDisplayEnabled,
    confirmationVersion: currentConfirmationVersion,
    effectiveAoiSignature,
    recommendedLayerCount: currentRecommendedLayers.length,
    selectedLayerCount: currentSelectedLayerIds.length,
    imageryLoading: agentImageryLoading,
    impactLoading: agentImpactLoading,
  }), {
    every: 15,
  });

  useEffect(() => {
    updateAgentDiagnosticsContext({
      analysisDisplayEnabled,
      confirmationVersion: currentConfirmationVersion,
      effectiveAoiSignature,
      recommendedLayerContextKey: recommendedLayerBaseContextKey,
      recommendedLayerCount: currentRecommendedLayers.length,
      selectedLayerCount: currentSelectedLayerIds.length,
      imageryLoading: agentImageryLoading,
      impactLoading: agentImpactLoading,
      currentPreDate,
      currentPeekDate,
      currentAfterDate,
    });
  }, [
    agentImpactLoading,
    agentImageryLoading,
    analysisDisplayEnabled,
    currentAfterDate,
    currentConfirmationVersion,
    currentPeekDate,
    currentPreDate,
    currentRecommendedLayers.length,
    currentSelectedLayerIds.length,
    effectiveAoiSignature,
    recommendedLayerBaseContextKey,
  ]);

  const removeMapLayerFromMap = useCallback((mapLayerId) => {
    const map = mapInstance;

    if (!mapLayerId || !map?.getLayer || !map?.getSource) {
      return;
    }

    try {
      if (map.getLayer(mapLayerId)) {
        map.removeLayer(mapLayerId);
      }
      if (map.getSource(mapLayerId)) {
        map.removeSource(mapLayerId);
      }
    } catch (error) {
      console.warn(`Failed to remove map layer ${mapLayerId}:`, error);
    }
  }, [mapInstance]);

  const layerManagerGroups = useAgentLayerManagerGroups({
    activeAnalysisAoi,
    agentImagery,
    agentLayerLoading,
    agentLayerProgress,
    agentRasterLayerVisibility,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentShowFloodDetection,
    analysisDisplayEnabled,
    buildAgentRasterRequestParams,
    catalogRenderAoi,
    controlPanelCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    fetchAgentRasterLayer,
    getCatalogLayerDateWindow,
    getRecommendedLayerContextKey,
    handleAgentRasterDownload,
    hotspotYearRange,
    layerData,
    rasterDownloadState,
    removeMapLayerFromMap,
    selectedAoiSignature,
    setAgentRasterLayerVisibility,
    setAgentRecommendedLayerVisibility,
    setAgentShowFloodDetection,
    setCatalogLayerTimeOverrides,
    setHotspotYearRange,
    setSingleInundationTimeWindow,
    setWarning,
    singleInundationTimeWindow,
  });

  useEffect(() => {
    if (!catalogRenderAoi || !controlPanelCatalogLayers.length) {
      setAgentRecommendedLayerVisibility({});
      setAgentRecommendedLayerData({});
      setAgentLayerOrder((previous) => previous.filter((layerId) => !String(layerId).startsWith('agent-rec-')));
      return;
    }

    const catalogLayerOrderIds = controlPanelCatalogLayers.map((layer) => getCatalogMapLayerId(layer.id));

    setAgentLayerOrder((previous) => {
      const filtered = previous.filter((layerId) => (
        !String(layerId).startsWith('agent-rec-') || catalogLayerOrderIds.includes(layerId)
      ));
      const missing = catalogLayerOrderIds.filter((layerId) => !filtered.includes(layerId));
      return [...filtered, ...missing];
    });

    setAgentRecommendedLayerVisibility((previous) => {
      const next = {};
      controlPanelCatalogLayers.forEach((layer) => {
        const requiresDateRange = layer.execution_profile?.requires_date_range !== false;
        const renderable = !requiresDateRange || isValidDateWindow(getCatalogLayerDateWindow(layer));
        next[layer.id] = Boolean(renderable && previous?.[layer.id]);
      });
      const previousKeys = Object.keys(previous || {});
      const unchanged = previousKeys.length === Object.keys(next).length
        && Object.entries(next).every(([layerId, visible]) => previous?.[layerId] === visible);
      return unchanged ? previous : next;
    });
  }, [
    catalogRenderAoi,
    currentConfirmationVersion,
    controlPanelCatalogLayers,
    controlPanelCatalogLayerSignature,
    getCatalogLayerDateWindow,
    setAgentLayerOrder,
    setAgentRecommendedLayerData,
    setAgentRecommendedLayerVisibility,
  ]);

  useEffect(() => {
    if (!analysisDisplayEnabled) {
      setAgentShowFloodDetection(false);
      setAgentShowPopulationLayer(false);
      setAgentShowUrbanLayer(false);
      setAgentShowLandcoverLayer(false);
      return;
    }

    const selectedIds = new Set(currentSelectedLayerIds);
    setAgentShowFloodDetection(selectedIds.has('core:flood_detection'));
    setAgentShowPopulationLayer(false);
    setAgentShowUrbanLayer(false);
    setAgentShowLandcoverLayer(false);
  }, [
    analysisDisplayEnabled,
    currentConfirmationVersion,
    currentSelectedLayerIds,
    currentRecommendedLayerSignature,
    setAgentShowFloodDetection,
    setAgentShowLandcoverLayer,
    setAgentShowPopulationLayer,
    setAgentShowUrbanLayer,
  ]);

  // Human-in-the-Loop: Handle LangGraph interrupt events
  useLangGraphInterrupt({
    enabled: ({ eventValue }) => eventValue?.type === "confirm_flood_event",
    render: ({ event, resolve }) => {
      const interruptData = event.value;

      return (
        <EventConfirmation
          data={interruptData.data}
          message={interruptData.message}
          onConfirm={(confirmedData) => {
            trackUxEvent('agent_confirmation_confirm', {
              event: confirmedData?.event || interruptData.data?.event || null,
            });
            resolve(JSON.stringify(confirmedData));
          }}
          onCancel={() => {
            trackUxEvent('agent_confirmation_cancel', {
              event: interruptData.data?.event || null,
            });
            resolve(JSON.stringify({ cancelled: true }));
          }}
        />
      );
    },
  });

  return (
    <Profiler id="AgentPanel" onRender={panelProfiler}>
      <div className="agent-panel-controls">
        <section className="agent-panel-section">
          <div className="section-header agent-panel-section-header">
            <span className="section-title">Layer Manager</span>
          </div>
          <div className="agent-panel-section-body layer-manager-body">
            <LayerManager
              groups={layerManagerGroups}
              layerOrder={agentLayerOrder}
              setLayerOrder={setAgentLayerOrder}
            />
          </div>
        </section>

        <AgentGeeCodeDownload
          code={downloadableGeeCode}
          eventName={currentEvent}
          disabledReason={geeCodeDisabledReason}
        />
      </div>
    </Profiler>
  );
}

export default AgentPanel;
