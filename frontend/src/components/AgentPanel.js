/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { useCoAgent, useLangGraphInterrupt, useCopilotMessagesContext } from "@copilotkit/react-core";
import {
  useAgentContext,
  useBusinessLayerContext,
  useMapContext,
  useUiContext,
} from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import SourcesDrawer from './SourcesDrawer';
import CatalogLayerPanel from './CatalogLayerPanel';
import LocationScopePicker from './LocationScopePicker';
import AoiUploadPanel from './AoiUploadPanel';
import { getFloodImages, getFloodImpact, renderRecommendedLayer } from '../services/agentApi';
import { buildAoiFromAgentState } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import { extractVisibleMessageText } from '../utils/mentionUtils';
import {
  buildVisibleCatalogLegendEntries,
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import './AgentPanel.css';

// FloodAgent 默认状态
const defaultAgentState = {
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
  confirmation_version: 0,
  search_sources: null,
  gee_code: null,
  is_valid_flood_query: false,
};

const buildRecommendedLayerContextKey = (state, aoi) => JSON.stringify({
  confirmation_version: state?.confirmation_version || 0,
  pre_date: state?.pre_date || null,
  peek_date: state?.peek_date || null,
  after_date: state?.after_date || null,
  bounds: aoi?.bounds || null,
  geojson: aoi?.geojson?.geometry || aoi?.geojson || null,
});

const areAoiScopesEquivalent = (left, right) => {
  if (!left?.geojson || !right?.geojson) {
    return false;
  }

  return (
    JSON.stringify(left.bounds || null) === JSON.stringify(right.bounds || null)
    && JSON.stringify(left.geojson?.geometry || left.geojson || null)
      === JSON.stringify(right.geojson?.geometry || right.geojson || null)
  );
};

const RECOMMENDED_LAYER_MAX_CONCURRENCY = 2;

// Download report as Markdown file
function downloadReport(report, eventName) {
  const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${eventName || 'flood_analysis_report'}_${new Date().toISOString().split('T')[0]}.md`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Download GEE JavaScript code file
function downloadGEECode(code, eventName) {
  const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(eventName || 'flood_analysis').replace(/\s+/g, '_')}_GEE_${new Date().toISOString().split('T')[0]}.js`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 影像信息图标组件
 * 显示每种影像类型在各个时期的元数据（来源、拼接、可用性等）
 */
function ImageryInfoIcon({ imageryData, type, selectedPeriod }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  // 点击外部关闭 popover
  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        iconRef.current && !iconRef.current.contains(e.target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  // 复制到剪贴板
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  // 计算 popover 位置
  const handleTogglePopover = (e) => {
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const popoverWidth = 290;
      const popoverHeight = 380;
      // 默认在图标右侧显示
      let left = rect.right + 8;
      let top = rect.top - 10;
      // 如果右边放不下，放到左侧
      if (left + popoverWidth > window.innerWidth - 10) {
        left = rect.left - popoverWidth - 8;
      }
      // 如果左边也放不下，居中显示
      if (left < 10) {
        left = Math.max(10, (window.innerWidth - popoverWidth) / 2);
      }
      // 如果底部超出，往上调
      if (top + popoverHeight > window.innerHeight - 10) {
        top = window.innerHeight - popoverHeight - 10;
      }
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // 当前选中时期的影像数据
  const currentPeriodData = imageryData?.[selectedPeriod]?.[type];
  const hasError = currentPeriodData?.error;

  // 汇总三个时期的信息
  const allPeriodsInfo = [
    { key: 'pre_date', label: 'Pre-Flood' },
    { key: 'peek_date', label: 'Peak' },
    { key: 'after_date', label: 'Post-Flood' },
  ].map(({ key, label }) => ({
    key,
    label,
    data: imageryData?.[key]?.[type],
  }));

  // 统计无影像的时期数量
  const missingCount = allPeriodsInfo.filter(p => p.data?.error || p.data?.image_count === 0).length;

  const popoverContent = showPopover ? createPortal(
    <div
      className="imagery-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">
          {type === 'sentinel2' ? '🌍 Sentinel-2 Optical' : '📡 Sentinel-1 SAR'}
        </span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>✕</button>
      </div>
      <div className="popover-body">
        {allPeriodsInfo.map(({ key, label, data }) => (
          <div key={key} className={`period-info-block ${selectedPeriod === key ? 'current' : ''}`}>
            <div className="period-info-header">
              <span className="period-info-label">{label}</span>
              {data?.error ? (
                <span className="period-status-badge error">N/A</span>
              ) : (
                <span className="period-status-badge success">Available</span>
              )}
            </div>
            {data?.error ? (
              <div className="no-imagery-detail">
                <div className="no-imagery-msg">⚠️ {data.error}</div>
                {data.search_range && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Search Range</span>
                    <span className="meta-value">{data.search_range}</span>
                  </div>
                )}
              </div>
            ) : data ? (
              <div className="imagery-detail">
                <div className="imagery-meta-row">
                  <span className="meta-label">Date</span>
                  <span className="meta-value">{data.date || '-'}</span>
                </div>
                {data.requested_date && data.date !== data.requested_date && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Requested</span>
                    <span className="meta-value">{data.requested_date}</span>
                  </div>
                )}
                <div className="imagery-meta-row">
                  <span className="meta-label">Satellite</span>
                  <span className="meta-value">{data.spacecraft || data.type || (type === 'sentinel2' ? 'Sentinel-2' : 'Sentinel-1')}</span>
                </div>
                <div className="imagery-meta-row">
                  <span className="meta-label">Mosaic</span>
                  <span className="meta-value">
                    {data.mosaic ? `Yes (${data.image_count} tiles)` : 'Single scene'}
                  </span>
                </div>
                {data.actual_date_range && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Date Range</span>
                    <span className="meta-value">{data.actual_date_range}</span>
                  </div>
                )}
                {data.cloud_cover !== undefined && data.cloud_cover !== null && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Cloud</span>
                    <span className="meta-value">{Number(data.cloud_cover).toFixed(1)}%</span>
                  </div>
                )}
                {data.polarization && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Polarization</span>
                    <span className="meta-value">{data.polarization}</span>
                  </div>
                )}
                {data.orbit_pass && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Orbit</span>
                    <span className="meta-value">{data.orbit_pass}</span>
                  </div>
                )}
                {data.resolution && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Resolution</span>
                    <span className="meta-value">{data.resolution}m</span>
                  </div>
                )}
                {data.mgrs_tile && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">MGRS Tile</span>
                    <span className="meta-value">{data.mgrs_tile}</span>
                  </div>
                )}
                {data.id && data.id !== 'unknown' && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Image ID</span>
                    <span
                      className={`meta-value id-value clickable ${copiedId === data.id ? 'copied' : ''}`}
                      title={`${data.id}\nClick to copy`}
                      onClick={() => copyToClipboard(data.id)}
                    >
                      {copiedId === data.id ? '✓ Copied!' : data.id}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="no-imagery-detail">
                <div className="no-imagery-msg">No data available</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className="imagery-info-wrapper">
      <span
        ref={iconRef}
        className={`imagery-info-icon ${hasError ? 'warning' : missingCount > 0 ? 'caution' : 'ok'}`}
        onClick={handleTogglePopover}
        title={hasError ? 'No imagery available for this period. Click for details.' : 'Click to view imagery source info'}
      >
        {hasError ? '!' : missingCount > 0 ? '!' : 'i'}
      </span>
      {popoverContent}
    </div>
  );
}

/**
 * Layer data source metadata (static info for each analysis layer)
 */
const LAYER_META = {
  flood_detection: {
    icon: '🌊',
    title: 'Flood Detection',
    source: 'Sentinel-1 GRD (C-band SAR)',
    method: 'Otsu Change Detection',
    resolution: '10m',
    auxiliary: 'JRC Global Surface Water v1.4',
    description: 'Detects newly flooded areas by comparing pre-flood and peak SAR backscatter, using Otsu thresholding on the change index. Permanent water bodies are excluded via JRC occurrence data.',
  },
  population: {
    icon: '👥',
    title: 'Population Impact',
    source: 'WorldPop — Global 100m Population',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Estimates affected population by overlaying the flood mask on WorldPop gridded population density.',
  },
  urban: {
    icon: '🏙️',
    title: 'Built-up Area',
    source: 'GHSL Built-up Surface 2020 (JRC)',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Calculates the flooded built-up area using the Global Human Settlement Layer.',
  },
  landcover: {
    icon: '🌳',
    title: 'Land Cover',
    source: 'ESA WorldCover 2021 (v200)',
    method: 'Per-class Area Calculation',
    resolution: '10m',
    auxiliary: null,
    description: 'Breaks down flooded area by ESA WorldCover classes (cropland, forest, built-up, grassland, etc.).',
  },
};

/**
 * Analysis Layer info icon — shows data source & stats for each layer
 */
function LayerInfoIcon({ layerType, floodDetectionData, impactData }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  const meta = LAYER_META[layerType];

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        iconRef.current && !iconRef.current.contains(e.target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  if (!meta) return null;

  // Compute popover position
  const handleToggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const pw = 300, ph = 320;
      let left = rect.right + 8;
      let top = rect.top - 10;
      if (left + pw > window.innerWidth - 10) left = rect.left - pw - 8;
      if (left < 10) left = Math.max(10, (window.innerWidth - pw) / 2);
      if (top + ph > window.innerHeight - 10) top = window.innerHeight - ph - 10;
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // Build dynamic stats rows
  const statsRows = [];
  if (layerType === 'flood_detection' && floodDetectionData) {
    if (floodDetectionData.stats?.flood_area_km2 != null) {
      statsRows.push({ label: 'Flooded Area', value: `${floodDetectionData.stats.flood_area_km2} km²` });
    }
    if (floodDetectionData.pre_date) statsRows.push({ label: 'Pre-flood Date', value: floodDetectionData.pre_date });
    if (floodDetectionData.peek_date) statsRows.push({ label: 'Peak Date', value: floodDetectionData.peek_date });
  }
  if (layerType === 'population' && impactData?.population && !impactData.population.error) {
    const p = impactData.population;
    statsRows.push({ label: 'Affected', value: `${(p.affected || 0).toLocaleString()} people` });
    statsRows.push({ label: 'Total in Region', value: `${(p.total || 0).toLocaleString()} people` });
    if (p.percentage != null) statsRows.push({ label: 'Percentage', value: `${p.percentage}%` });
    if (p.data_source) statsRows.push({ label: 'Data Year', value: p.data_source });
  }
  if (layerType === 'urban' && impactData?.urban && !impactData.urban.error) {
    const u = impactData.urban;
    statsRows.push({ label: 'Affected Built-up', value: `${u.affected_area_km2} km²` });
    statsRows.push({ label: 'Total Built-up', value: `${u.total_area_km2} km²` });
    if (u.percentage != null) statsRows.push({ label: 'Percentage', value: `${u.percentage}%` });
  }
  if (layerType === 'landcover' && impactData?.landcover && !impactData.landcover.error) {
    const lc = impactData.landcover;
    if (lc.breakdown) {
      Object.entries(lc.breakdown).forEach(([key, val]) => {
        statsRows.push({ label: key.charAt(0).toUpperCase() + key.slice(1), value: `${val.area_km2} km²` });
      });
    }
  }

  const hasStats = statsRows.length > 0;

  const popoverContent = showPopover ? createPortal(
    <div
      className="layer-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">{meta.icon} {meta.title}</span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>✕</button>
      </div>
      <div className="popover-body">
        <div className="layer-meta-section">
          <div className="layer-meta-subtitle">Data Source</div>
          <div className="imagery-meta-row">
            <span className="meta-label">Source</span>
            <span className="meta-value">{meta.source}</span>
          </div>
          <div className="imagery-meta-row">
            <span className="meta-label">Method</span>
            <span className="meta-value">{meta.method}</span>
          </div>
          <div className="imagery-meta-row">
            <span className="meta-label">Resolution</span>
            <span className="meta-value">{meta.resolution}</span>
          </div>
          {meta.auxiliary && (
            <div className="imagery-meta-row">
              <span className="meta-label">Auxiliary</span>
              <span className="meta-value">{meta.auxiliary}</span>
            </div>
          )}
        </div>
        {hasStats && (
          <div className="layer-meta-section">
            <div className="layer-meta-subtitle">Statistics</div>
            {statsRows.map((row, i) => (
              <div key={i} className="imagery-meta-row">
                <span className="meta-label">{row.label}</span>
                <span className="meta-value">{row.value}</span>
              </div>
            ))}
          </div>
        )}
        <div className="layer-meta-description">{meta.description}</div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span
      ref={iconRef}
      className="layer-info-icon"
      onClick={handleToggle}
      title="Click to view data source info"
    >
      ⓘ
      {popoverContent}
    </span>
  );
}

function AgentPanel() {
  const { setWarning } = useUiContext();

  const {
    setFloodAgentState, 
    floodAgentState,
    setAgentImagery,
    setAgentImageryLoading,
    agentImagery,
    agentImageryLoading,
    // Agent control states from context
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
    agentRecommendedLayerData,
    setAgentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    setAgentRecommendedLayerVisibility,
    agentLayerLoading,
    setAgentLayerLoading,
    agentTileError,
    setAgentTileError,
  } = useAgentContext();

  const {
    businessLayers,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
  } = useBusinessLayerContext();

  const { selectedAOI } = useMapContext();
  
  // Get chat messages from CopilotKit (with safety check)
  const messagesContext = useCopilotMessagesContext();
  const messages = messagesContext?.messages || [];
  
  // Local UI state (for section expansion only)
  const [sourcesDrawerOpen, setSourcesDrawerOpen] = useState(false);
  const [locationScopePickerOpen, setLocationScopePickerOpen] = useState(false);
  const uploadPanelRef = useRef(null);
  const [expandedSections, setExpandedSections] = useState({
    event: true,
    dates: false,
    imagery: false,
    layers: false,
    impact: false,
    spatialScope: true,
    chatHistory: false,
  });

  const { state } = useCoAgent({
    name: "flood_agent",
    initialState: defaultAgentState,
  });

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
  const imageryRequestAbortRef = useRef(null);
  const impactRequestAbortRef = useRef(null);
  const pendingRecommendedLayerRequestsRef = useRef(new Set());

  useEffect(() => {
    if (state) {
      setFloodAgentState(state);
    }
  }, [state, setFloodAgentState]);

  const currentState = state || floodAgentState;
  const agentDerivedAoi = buildAoiFromAgentState(currentState, {
    source: 'agent_geocode',
    label: currentState.location || 'Agent-derived scope',
  });
  const selectedBusinessScope = isBusinessLayerAoiSource(selectedAOI?.source) ? selectedAOI : null;
  const analysisScopeMatchesSelection = selectedBusinessScope
    ? areAoiScopesEquivalent(selectedBusinessScope, agentDerivedAoi)
    : true;
  const hasResolvedAnalysisContext = Boolean(
    currentState?.event
    && currentState?.pre_date
    && currentState?.peek_date
    && currentState?.after_date
    && (agentDerivedAoi || currentState?.coordinates)
  );
  const analysisDisplayEnabled = hasResolvedAnalysisContext && analysisScopeMatchesSelection;
  const effectiveAoi = analysisDisplayEnabled ? agentDerivedAoi : null;
  const recommendedCatalogLayers = useMemo(
    () => sortCatalogLayers(
      (currentState.recommended_layers || []).filter((layer) => layer.layer_family === 'catalog')
    ),
    [currentState.recommended_layers]
  );
  const confirmedRecommendedCatalogLayers = useMemo(() => {
    const confirmedIds = new Set(currentState.selected_layer_ids || []);
    return recommendedCatalogLayers.filter((layer) => confirmedIds.has(layer.id));
  }, [currentState.selected_layer_ids, recommendedCatalogLayers]);
  const recommendedLayerContextKey = buildRecommendedLayerContextKey(currentState, effectiveAoi);
  const recommendedLegendEntries = useMemo(
    () => buildVisibleCatalogLegendEntries({
      layers: confirmedRecommendedCatalogLayers,
      runtimeData: agentRecommendedLayerData,
      visibility: agentRecommendedLayerVisibility,
    }),
    [agentRecommendedLayerData, agentRecommendedLayerVisibility, confirmedRecommendedCatalogLayers]
  );
  const scopeSourceLabel = useCallback((source) => {
    const normalizedSource = String(source || '').toLowerCase();
    if (normalizedSource === 'place_search') return 'place search';
    if (normalizedSource === 'draw') return 'draw';
    if (normalizedSource === 'upload') return 'upload';
    if (normalizedSource === 'edited') return 'edited';
    return normalizedSource || 'scope';
  }, []);

  const handleOpenSpatialUpload = useCallback(() => {
    uploadPanelRef.current?.openFilePicker?.();
    trackUxEvent('agent_scope_upload_open', { mode: 'agent' });
  }, []);

  useEffect(() => {
    if (!analysisDisplayEnabled || !(currentState.recommended_layers || []).length) {
      setAgentRecommendedLayerVisibility({});
      setAgentRecommendedLayerData({});
      return;
    }

    setAgentRecommendedLayerVisibility(() => {
      const next = {};
      (currentState.recommended_layers || []).forEach((layer) => {
        next[layer.id] = (currentState.selected_layer_ids || []).includes(layer.id);
      });
      return next;
    });
  }, [
    analysisDisplayEnabled,
    currentState.confirmation_version,
    currentState.recommended_layers,
    currentState.selected_layer_ids,
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

    const selectedIds = currentState.selected_layer_ids || [];
    setAgentShowFloodDetection(selectedIds.includes('core:flood_detection'));
    setAgentShowPopulationLayer(selectedIds.includes('core:population'));
    setAgentShowUrbanLayer(selectedIds.includes('core:urban'));
    setAgentShowLandcoverLayer(selectedIds.includes('core:landcover'));
  }, [
    analysisDisplayEnabled,
    currentState.selected_layer_ids,
    setAgentShowFloodDetection,
    setAgentShowLandcoverLayer,
    setAgentShowPopulationLayer,
    setAgentShowUrbanLayer,
  ]);

  useEffect(() => {
    setAgentRecommendedLayerData({});
    pendingRecommendedLayerRequestsRef.current.clear();
  }, [recommendedLayerContextKey, setAgentRecommendedLayerData]);

  const fetchAgentImagery = useCallback(async (agentState, aoi) => {
    const requestKey = JSON.stringify({
      pre_date: agentState.pre_date,
      peek_date: agentState.peek_date,
      after_date: agentState.after_date,
      bounds: aoi?.bounds || agentState.bounds || null,
      geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      coordinates: agentState.coordinates || null,
    });

    if (imageryRequestKeyRef.current === requestKey) {
      return;
    }

    imageryRequestKeyRef.current = requestKey;
    imageryRequestAbortRef.current?.abort();
    const controller = new AbortController();
    imageryRequestAbortRef.current = controller;
    impactRequestKeyRef.current = null;
    setAgentImagery(null);
    setAgentImpactData(null);
    setAgentTileError(null);
    setAgentImageryLoading(true);
    setWarning('');

    try {
      const result = await getFloodImages({
        pre_date: agentState.pre_date,
        peek_date: agentState.peek_date,
        after_date: agentState.after_date,
        longitude: agentState.coordinates?.[0] || 0,
        latitude: agentState.coordinates?.[1] || 0,
        bounds: aoi?.bounds || agentState.bounds || null,
        geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      }, { signal: controller.signal });

      if (imageryRequestKeyRef.current !== requestKey) {
        return;
      }

      if (result?.success) {
        setAgentImagery(result.data);
        setWarning('');
        trackUxEvent('imagery_request_success', {
          source: aoi?.source || 'agent',
          mode: 'agent',
        });
      } else {
        throw new Error('Flood imagery response was not successful.');
      }
    } catch (error) {
      if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
        return;
      }
      console.error('Failed to fetch imagery:', error);
      if (imageryRequestKeyRef.current !== requestKey) {
        return;
      }
      if (imageryRequestKeyRef.current === requestKey) {
        imageryRequestKeyRef.current = null;
      }
      setWarning(error?.message || 'Flood imagery request failed.');
      trackUxEvent('imagery_request_fail', {
        mode: 'agent',
        error: error?.message || 'Unknown imagery error',
      });
    } finally {
      if (imageryRequestAbortRef.current === controller) {
        imageryRequestAbortRef.current = null;
      }
      if (imageryRequestKeyRef.current === requestKey) {
        setAgentImageryLoading(false);
      }
    }
  }, [setAgentImagery, setAgentImageryLoading, setAgentImpactData, setAgentTileError, setWarning]);

  useEffect(() => {
    if (!analysisDisplayEnabled || !currentState.pre_date || !currentState.peek_date || !currentState.after_date) {
      imageryRequestAbortRef.current?.abort();
      imageryRequestKeyRef.current = null;
      return;
    }

    if (effectiveAoi || currentState.coordinates) {
      fetchAgentImagery(currentState, effectiveAoi);
    }
  }, [
    analysisDisplayEnabled,
    currentState,
    currentState.pre_date,
    currentState.peek_date,
    currentState.after_date,
    currentState.coordinates,
    effectiveAoi,
    fetchAgentImagery,
  ]);

  // Fetch flood impact assessment data
  const fetchImpactData = useCallback(async () => {
    if (!analysisDisplayEnabled || !currentState.pre_date || !currentState.peek_date) return;

    const requestKey = JSON.stringify({
      pre_date: currentState.pre_date,
      peek_date: currentState.peek_date,
      bounds: effectiveAoi?.bounds || currentState.bounds || null,
      geojson: effectiveAoi?.geojson?.geometry || currentState.geojson?.geometry || currentState.geojson || null,
    });

    if (impactRequestKeyRef.current === requestKey && agentImpactData) {
      return;
    }
    
    impactRequestKeyRef.current = requestKey;
    impactRequestAbortRef.current?.abort();
    const controller = new AbortController();
    impactRequestAbortRef.current = controller;
    setAgentImpactLoading(true);
    setWarning('');
    try {
      const result = await getFloodImpact({
        pre_date: currentState.pre_date,
        peek_date: currentState.peek_date,
        bounds: effectiveAoi?.bounds || currentState.bounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentState.geojson || null,
      }, { signal: controller.signal });

      if (impactRequestKeyRef.current !== requestKey) {
        return;
      }

      if (result.success) {
        setAgentImpactData(result.data);
        setWarning('');
        trackUxEvent('impact_request_success', {
          mode: 'agent',
          source: effectiveAoi?.source || 'agent',
        });
      }
    } catch (error) {
      if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
        return;
      }
      console.error('Failed to fetch impact data:', error);
      if (impactRequestKeyRef.current !== requestKey) {
        return;
      }
      if (impactRequestKeyRef.current === requestKey) {
        impactRequestKeyRef.current = null;
      }
      setWarning(error?.message || 'Flood impact request failed.');
      trackUxEvent('impact_request_fail', {
        mode: 'agent',
        error: error?.message || 'Unknown impact error',
      });
    } finally {
      if (impactRequestAbortRef.current === controller) {
        impactRequestAbortRef.current = null;
      }
      if (impactRequestKeyRef.current === requestKey) {
        setAgentImpactLoading(false);
      }
    }
  }, [agentImpactData, analysisDisplayEnabled, currentState, effectiveAoi, setAgentImpactData, setAgentImpactLoading, setWarning]);

  // Auto-fetch impact data in background as soon as imagery arrives
  useEffect(() => {
    if (!analysisDisplayEnabled || !currentState.pre_date || !currentState.peek_date) {
      impactRequestAbortRef.current?.abort();
      impactRequestKeyRef.current = null;
      return;
    }

    if (agentImagery && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentImagery, agentImpactData, agentImpactLoading, analysisDisplayEnabled, currentState.pre_date, currentState.peek_date, fetchImpactData]);

  // Also fetch if user enables an impact layer before data arrived
  useEffect(() => {
    if (!analysisDisplayEnabled) {
      return;
    }

    if ((agentShowPopulationLayer || agentShowUrbanLayer || agentShowLandcoverLayer) && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentShowPopulationLayer, agentShowUrbanLayer, agentShowLandcoverLayer, agentImpactData, agentImpactLoading, analysisDisplayEnabled, fetchImpactData]);

  useEffect(() => () => {
    imageryRequestAbortRef.current?.abort();
    impactRequestAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    const visibleCatalogLayers = recommendedCatalogLayers.filter((layer) => agentRecommendedLayerVisibility[layer.id]);
    if (!analysisDisplayEnabled || !visibleCatalogLayers.length || !effectiveAoi) {
      return;
    }

    let cancelled = false;
    const layersToRender = visibleCatalogLayers.filter((layer) => {
      const cached = agentRecommendedLayerData?.[layer.id];
      const requestToken = `${recommendedLayerContextKey}:${layer.id}`;
      return !(
        (cached?.tile_url && cached?.context_key === recommendedLayerContextKey)
        || pendingRecommendedLayerRequestsRef.current.has(requestToken)
      );
    });

    if (!layersToRender.length) {
      return undefined;
    }

    const processLayer = async (layer) => {
      const requestToken = `${recommendedLayerContextKey}:${layer.id}`;

      pendingRecommendedLayerRequestsRef.current.add(requestToken);
      setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: true }));

      try {
        const result = await renderRecommendedLayer({
          layer_id: layer.id,
          recommended_layers: currentState.recommended_layers || [],
          confirmed_aoi: effectiveAoi,
          pre_date: currentState.pre_date,
          peek_date: currentState.peek_date,
          after_date: currentState.after_date,
        });

        if (cancelled || !result?.success) {
          return;
        }

        setAgentRecommendedLayerData((previous) => ({
          ...previous,
          [layer.id]: {
            ...result.data,
            context_key: recommendedLayerContextKey,
          },
        }));
      } catch (error) {
        if (!cancelled) {
          setWarning(error?.message || 'Failed to render recommended layer.');
        }
      } finally {
        pendingRecommendedLayerRequestsRef.current.delete(requestToken);
        if (!cancelled) {
          setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: false }));
        }
      }
    };

    const runRenderQueue = async () => {
      for (let index = 0; index < layersToRender.length && !cancelled; index += RECOMMENDED_LAYER_MAX_CONCURRENCY) {
        const batch = layersToRender.slice(index, index + RECOMMENDED_LAYER_MAX_CONCURRENCY);
        await Promise.allSettled(batch.map((layer) => processLayer(layer)));
      }
    };

    runRenderQueue();
    
    return () => {
      cancelled = true;
    };
  }, [
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    analysisDisplayEnabled,
    currentState.after_date,
    currentState.peek_date,
    currentState.pre_date,
    currentState.recommended_layers,
    effectiveAoi,
    recommendedCatalogLayers,
    recommendedLayerContextKey,
    setAgentLayerLoading,
    setAgentRecommendedLayerData,
    setWarning,
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

  const hasValidDates = currentState.pre_date && currentState.peek_date && currentState.after_date;

  // Toggle section expansion
  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Date periods for display
  const periods = [
    { key: 'pre_date', label: 'Pre-Flood', date: currentState.pre_date },
    { key: 'peek_date', label: 'Peak', date: currentState.peek_date },
    { key: 'after_date', label: 'Post-Flood', date: currentState.after_date },
  ];

  return (
    <div className="agent-panel-controls">
      {/* Sources Drawer */}
      <SourcesDrawer
        sources={currentState.search_sources || []}
        isOpen={sourcesDrawerOpen}
        onClose={() => setSourcesDrawerOpen(false)}
      />

      {/* Event Info Section */}
      <div className={`control-section ${expandedSections.event ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('event')}>
          <span className="section-icon">📍</span>
          <span className="section-title">Event Info</span>
          <span className={`expand-icon ${expandedSections.event ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.event && (
          <div className="section-body">
            {currentState.event ? (
              <>
                <div className="info-row">
                  <span className="info-label">Event:</span>
                  <span className="info-value">{currentState.event}</span>
                </div>
                {currentState.location && (
                  <div className="info-row">
                    <span className="info-label">Location:</span>
                    <span className="info-value">{currentState.location}</span>
                  </div>
                )}
                {currentState.event_description && (
                  <div className="info-row description">
                    <span className="info-value">{currentState.event_description}</span>
                  </div>
                )}
                {(currentState.search_sources?.length > 0 || currentState.flood_report) && (
                  <div className="action-buttons">
                    {currentState.search_sources?.length > 0 && (
                      <button 
                        className="action-btn"
                        onClick={() => setSourcesDrawerOpen(true)}
                      >
                        🌐 Sources ({currentState.search_sources.length})
                      </button>
                    )}
                    {currentState.flood_report && (
                      <button 
                        className="action-btn"
                        onClick={() => {
                          trackUxEvent('export_report', {
                            event: currentState.event || null,
                            mode: 'agent',
                          });
                          downloadReport(currentState.flood_report, currentState.event);
                        }}
                      >
                        📥 Download Report
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="no-data-hint">
                <span>💬 Ask about a flood event in the chat below</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Impact Assessment Section */}
      <div className={`control-section ${expandedSections.impact ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('impact')}>
          <span className="section-icon">📊</span>
          <span className="section-title">Impact Assessment</span>
          <span className={`expand-icon ${expandedSections.impact ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.impact && (
          <div className="section-body">
            {agentImpactLoading ? (
              <div className="loading-indicator">
                <span className="spinner">⏳</span> Calculating impact assessment...
              </div>
            ) : agentImpactData ? (
              <div className="impact-stats">
                <div className="impact-stat-item">
                  <span className="impact-icon">🌊</span>
                  <span className="impact-label">Flooded Area</span>
                  <span className="impact-value">
                    {agentImagery?.flood_detection?.stats?.flood_area_km2 || agentImpactData.flood_area?.value?.toFixed(2) || 0} km²
                  </span>
                </div>
                <div className="impact-stat-item">
                  <span className="impact-icon">👥</span>
                  <span className="impact-label">Affected Population</span>
                  <span className="impact-value">
                    {(agentImpactData.population?.affected || 0).toLocaleString()}
                  </span>
                </div>
                <div className="impact-stat-item">
                  <span className="impact-icon">🏙️</span>
                  <span className="impact-label">Built-up Flooded</span>
                  <span className="impact-value">
                    {agentImpactData.urban?.affected_area_km2?.toFixed(2) || 0} km²
                  </span>
                </div>
                <div className="impact-source">
                  Data: WorldPop · ESA WorldCover · GHSL
                </div>
              </div>
            ) : (
              <div className="no-impact-data">
                <p>Enable analysis layers to calculate impact</p>
                <button 
                  className="load-impact-btn"
                  onClick={() => {
                    trackUxEvent('impact_request_manual', {
                      mode: 'agent',
                      event: currentState.event || null,
                    });
                    fetchImpactData();
                  }}
                  disabled={!currentState?.pre_date || !currentState?.peek_date}
                >
                  Calculate Now
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Date Selection Section */}
      <div className={`control-section ${expandedSections.dates ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('dates')}>
          <span className="section-icon">📅</span>
          <span className="section-title">Date Selection</span>
          <span className={`expand-icon ${expandedSections.dates ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.dates && (
          <div className="section-body">
            {hasValidDates ? (
              <div className="date-timeline">
                {periods.map((p, i) => (
                  <div key={p.key} className="timeline-item">
                    <button
                      className={`date-btn ${agentSelectedPeriod === p.key ? 'active' : ''}`}
                      onClick={() => setAgentSelectedPeriod(p.key)}
                      disabled={agentLayerLoading['base-imagery']}
                    >
                      <span className="period-label">{p.label}</span>
                      <span className="period-date">{p.date || '-'}</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-data-hint">
                <span>Dates will appear after analyzing an event</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Imagery Type Section */}
      <div className={`control-section ${expandedSections.imagery ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('imagery')}>
          <span className="section-icon">🛰️</span>
          <span className="section-title">Imagery Type</span>
          <span className={`expand-icon ${expandedSections.imagery ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.imagery && (
          <div className="section-body">
            <div className="imagery-type-buttons">
              <div className="imagery-type-item">
                <button
                  className={`type-btn ${agentSelectedType === 'sentinel2' ? 'active' : ''}`}
                  onClick={() => setAgentSelectedType('sentinel2')}
                  disabled={agentLayerLoading['base-imagery']}
                >
                  🌍 Optical (S2)
                </button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel2')) ? (
                  <span className="imagery-spinner" title="Loading..." />
                ) : agentImagery ? (
                  <ImageryInfoIcon
                    imageryData={agentImagery}
                    type="sentinel2"
                    selectedPeriod={agentSelectedPeriod}
                  />
                ) : null}
              </div>
              <div className="imagery-type-item">
                <button
                  className={`type-btn ${agentSelectedType === 'sentinel1' ? 'active' : ''}`}
                  onClick={() => setAgentSelectedType('sentinel1')}
                  disabled={agentLayerLoading['base-imagery']}
                >
                  📡 SAR Radar (S1)
                </button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel1')) ? (
                  <span className="imagery-spinner" title="Loading..." />
                ) : agentImagery ? (
                  <ImageryInfoIcon
                    imageryData={agentImagery}
                    type="sentinel1"
                    selectedPeriod={agentSelectedPeriod}
                  />
                ) : null}
              </div>
            </div>

    
          </div>
        )}
      </div>

      {/* Analysis Layers Section */}
      <div className={`control-section ${expandedSections.layers ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('layers')}>
          <span className="section-icon">🗺️</span>
          <span className="section-title">Analysis Layers</span>
          <span className={`expand-icon ${expandedSections.layers ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.layers && (
          <div className="section-body">
            <div className="layer-toggles">
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowFloodDetection}
                    onChange={() => setAgentShowFloodDetection(!agentShowFloodDetection)}
                  />
                  <span className="layer-icon">🌊</span>
                  <span>Flood Detection</span>
                </label>
                {agentLayerLoading['flood-detection'] ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="flood_detection"
                    floodDetectionData={agentImagery?.flood_detection}
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowPopulationLayer}
                    onChange={() => setAgentShowPopulationLayer(!agentShowPopulationLayer)}
                  />
                  <span className="layer-icon">👥</span>
                  <span>Population Impact</span>
                </label>
                {(agentLayerLoading['population'] || (agentShowPopulationLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="population"
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowUrbanLayer}
                    onChange={() => setAgentShowUrbanLayer(!agentShowUrbanLayer)}
                  />
                  <span className="layer-icon">🏙️</span>
                  <span>Built-up Area</span>
                </label>
                {(agentLayerLoading['urban'] || (agentShowUrbanLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="urban"
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowLandcoverLayer}
                    onChange={() => setAgentShowLandcoverLayer(!agentShowLandcoverLayer)}
                  />
                  <span className="layer-icon">🌳</span>
                  <span>Land Cover</span>
                </label>
                {(agentLayerLoading['landcover'] || (agentShowLandcoverLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="landcover"
                    impactData={agentImpactData}
                  />
                )}
              </div>
            </div>

            {confirmedRecommendedCatalogLayers.length > 0 && (
              <CatalogLayerPanel
                layers={confirmedRecommendedCatalogLayers}
                runtimeData={agentRecommendedLayerData}
                visibility={agentRecommendedLayerVisibility}
                loading={agentLayerLoading}
                onToggle={(layerId) => {
                  setAgentRecommendedLayerVisibility((previous) => ({
                    ...previous,
                    [layerId]: !previous[layerId],
                  }));
                }}
              />
            )}

            {/* Tile Error Warning */}
            {agentTileError && (
              <div className="tile-error-banner">
                <span className="tile-error-icon">⚠️</span>
                <span className="tile-error-msg">{agentTileError.message}</span>
              </div>
            )}
            
            {/* Layer Legend */}
            <div className="layer-legend">
              <h5>Legend</h5>
              <div className="legend-items">
                {agentShowFloodDetection && (
                  <div className="legend-item">
                    <span className="legend-color" style={{ background: '#ff4444' }}></span>
                    <span>Flooded Area</span>
                  </div>
                )}
                {agentShowPopulationLayer && (
                  <div className="legend-item">
                    <span className="legend-gradient population"></span>
                    <span>Population Density</span>
                  </div>
                )}
                {agentShowUrbanLayer && (
                  <div className="legend-item">
                    <span className="legend-color" style={{ background: '#ff6600' }}></span>
                    <span>Built-up</span>
                  </div>
                )}
                {agentShowLandcoverLayer && (
                  <div className="legend-row">
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#006400' }}></span>
                      <span>Forest</span>
                    </div>
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#ffbb22' }}></span>
                      <span>Crop</span>
                    </div>
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#0064c8' }}></span>
                      <span>Water</span>
                    </div>
                  </div>
                )}
                {recommendedLegendEntries.map((entry) => (
                  entry.legendModel.type === 'palette' ? (
                    <div className="legend-item recommended" key={entry.id}>
                      <span
                        className="legend-gradient recommended"
                        style={{
                          background: `linear-gradient(90deg, ${entry.legendModel.palette.join(', ')})`,
                        }}
                      ></span>
                      <span>
                        {entry.legendModel.label}
                        {(entry.legendModel.min !== undefined && entry.legendModel.max !== undefined)
                          ? ` (${entry.legendModel.min} - ${entry.legendModel.max})`
                          : ''}
                      </span>
                    </div>
                  ) : entry.legendModel.type === 'classes' ? (
                    <div className="legend-item recommended classes" key={entry.id}>
                      <div className="legend-class-list">
                        {entry.legendModel.items.map((item) => (
                          <div className="legend-class-item" key={`${entry.id}-${item.value}`}>
                            <span
                              className="legend-dot square"
                              style={{ background: item.color }}
                            ></span>
                            <span>{item.value}: {item.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : entry.legendModel.type === 'text' ? (
                    <div className="legend-item recommended text-only" key={entry.id}>
                      <span>{entry.legendModel.label}</span>
                    </div>
                  ) : (
                    <div className="legend-item recommended" key={entry.id}>
                      <span
                        className="legend-color"
                        style={{ background: entry.legendModel.color }}
                      ></span>
                      <span>{entry.legendModel.label}</span>
                    </div>
                  )
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={`control-section ${expandedSections.spatialScope ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('spatialScope')}>
          <span className="section-icon"><i className="fa fa-crop" aria-hidden="true" /></span>
          <span className="section-title">Spatial Scope</span>
          <span className={`expand-icon ${expandedSections.spatialScope ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.spatialScope && (
          <div className="section-body spatial-scope-body">
            <div className="spatial-scope-action-row">
              <button
                type="button"
                className="action-btn primary"
                onClick={() => setLocationScopePickerOpen(true)}
              >
                <i className="fa fa-search" aria-hidden="true" />
                Search Place
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={handleOpenSpatialUpload}
              >
                <i className="fa fa-upload" aria-hidden="true" />
                Upload Scope
              </button>
            </div>

            {businessLayers?.length ? (
              <div className="spatial-scope-list">
                {businessLayers.map((layer) => (
                  <div
                    key={layer.id}
                    className={`spatial-scope-item ${layer.is_active ? 'active' : ''}`}
                    title={layer.id}
                  >
                    <button
                      type="button"
                      className="spatial-scope-item-main"
                      onClick={() => activateBusinessLayerRecord(layer.id)}
                    >
                      <span className="spatial-scope-item-label">@{layer.label}</span>
                      <span className="spatial-scope-item-meta">
                        {scopeSourceLabel(layer.source)}
                        {layer.is_active ? ' - active' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="spatial-scope-item-delete"
                      aria-label={`Delete ${layer.label}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteBusinessLayer(layer.id);
                      }}
                    >
                      <i className="fa fa-trash" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-data-hint">
                No uploaded or drawn scope yet.
              </div>
            )}
          </div>
        )}
      </div>

      <LocationScopePicker
        isOpen={locationScopePickerOpen}
        onClose={() => setLocationScopePickerOpen(false)}
      />
      <AoiUploadPanel
        ref={uploadPanelRef}
        variant="agent"
        presentation="hidden"
        lightweight
      />

      {/* Chat History Section */}
      <div className="control-section">
        <div className="section-header" onClick={() => toggleSection('chatHistory')}>
          <span className="section-icon">💬</span>
          <span className="section-title">Chat History</span>
          <span className={`expand-icon ${expandedSections.chatHistory ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.chatHistory && (
          <div className="section-body chat-history-section">
            {messages && messages.length > 0 ? (
              <div className="chat-history-list">
                {messages.map((msg, index) => (
                  <div 
                    key={msg.id || index} 
                    className={`chat-history-item ${msg.role === 'user' ? 'user-msg' : 'assistant-msg'}`}
                  >
                    <div className="msg-role">
                      {msg.role === 'user' ? '👤 You' : '🤖 Agent'}
                    </div>
                    <div className="msg-content">
                      {extractVisibleMessageText(msg.content) || ''}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-messages">
                <span className="empty-icon">💭</span>
                <p>No conversation yet. Start chatting with the agent!</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* GEE Code Download - bottom of panel, same style as Ask mode */}
      <div className="download-btn-div">
        <button
          type="button"
          className={`submit btn download ${!currentState.gee_code ? 'disabled' : ''}`}
          onClick={() => {
            if (!currentState.gee_code) {
              return;
            }
            trackUxEvent('export_gee_code', {
              event: currentState.event || null,
              mode: 'agent',
            });
            downloadGEECode(currentState.gee_code, currentState.event);
          }}
          style={{ 
            cursor: currentState.gee_code ? 'pointer' : 'not-allowed',
            opacity: currentState.gee_code ? 1 : 0.5,
            pointerEvents: currentState.gee_code ? 'auto' : 'none',
          }}
        >
          DOWNLOAD GEE CODE
        </button>
      </div>
    </div>
  );
}

export default AgentPanel;
