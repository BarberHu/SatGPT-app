/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useCoAgent, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import LocationScopePicker from './LocationScopePicker';
import { getFloodImages, getFloodImpact, renderRecommendedLayer } from '../services/agentApi';
import { buildAoiFromAgentState } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import {
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import './AgentPanel.css';

// FloodAgent 榛樿鐘舵€?
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
 * 褰卞儚淇℃伅鍥炬爣缁勪欢
 * 鏄剧ず姣忕褰卞儚绫诲瀷鍦ㄥ悇涓椂鏈熺殑鍏冩暟鎹紙鏉ユ簮銆佹嫾鎺ャ€佸彲鐢ㄦ€х瓑锛?
 */
// eslint-disable-next-line no-unused-vars
function ImageryInfoIcon({ imageryData, type, selectedPeriod }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  // 鐐瑰嚮澶栭儴鍏抽棴 popover
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

  // 澶嶅埗鍒板壀璐存澘
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

  // 璁＄畻 popover 浣嶇疆
  const handleTogglePopover = (e) => {
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const popoverWidth = 290;
      const popoverHeight = 380;
      // 榛樿鍦ㄥ浘鏍囧彸渚ф樉绀?
      let left = rect.right + 8;
      let top = rect.top - 10;
      // 濡傛灉鍙宠竟鏀句笉涓嬶紝鏀惧埌宸︿晶
      if (left + popoverWidth > window.innerWidth - 10) {
        left = rect.left - popoverWidth - 8;
      }
      // 濡傛灉宸﹁竟涔熸斁涓嶄笅锛屽眳涓樉绀?
      if (left < 10) {
        left = Math.max(10, (window.innerWidth - popoverWidth) / 2);
      }
      // 濡傛灉搴曢儴瓒呭嚭锛屽線涓婅皟
      if (top + popoverHeight > window.innerHeight - 10) {
        top = window.innerHeight - popoverHeight - 10;
      }
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // 褰撳墠閫変腑鏃舵湡鐨勫奖鍍忔暟鎹?
  const currentPeriodData = imageryData?.[selectedPeriod]?.[type];
  const hasError = currentPeriodData?.error;

  // 姹囨€讳笁涓椂鏈熺殑淇℃伅
  const allPeriodsInfo = [
    { key: 'pre_date', label: 'Pre-Flood' },
    { key: 'peek_date', label: 'Peak' },
    { key: 'after_date', label: 'Post-Flood' },
  ].map(({ key, label }) => ({
    key,
    label,
    data: imageryData?.[key]?.[type],
  }));

  // 缁熻鏃犲奖鍍忕殑鏃舵湡鏁伴噺
  const missingCount = allPeriodsInfo.filter(p => p.data?.error || p.data?.image_count === 0).length;

  const popoverContent = showPopover ? createPortal(
    <div
      className="imagery-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">
          {type === 'sentinel2' ? 'Sentinel-2 Optical' : 'Sentinel-1 SAR'}
        </span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>x</button>
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
                <div className="no-imagery-msg">{data.error}</div>
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
                      {copiedId === data.id ? '鉁?Copied!' : data.id}
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
    title: 'Flood Detection',
    source: 'Sentinel-1 GRD (C-band SAR)',
    method: 'Otsu Change Detection',
    resolution: '10m',
    auxiliary: 'JRC Global Surface Water v1.4',
    description: 'Detects newly flooded areas by comparing pre-flood and peak SAR backscatter, using Otsu thresholding on the change index. Permanent water bodies are excluded via JRC occurrence data.',
  },
  population: {
    title: 'Population Impact',
    source: 'WorldPop - Global 100m Population',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Estimates affected population by overlaying the flood mask on WorldPop gridded population density.',
  },
  urban: {
    title: 'Built-up Area',
    source: 'GHSL Built-up Surface 2020 (JRC)',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Calculates the flooded built-up area using the Global Human Settlement Layer.',
  },
  landcover: {
    title: 'Land Cover',
    source: 'ESA WorldCover 2021 (v200)',
    method: 'Per-class Area Calculation',
    resolution: '10m',
    auxiliary: null,
    description: 'Breaks down flooded area by ESA WorldCover classes (cropland, forest, built-up, grassland, etc.).',
  },
};

/**
 * Analysis Layer info icon 鈥?shows data source & stats for each layer
 */
// eslint-disable-next-line no-unused-vars
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
      statsRows.push({ label: 'Flooded Area', value: `${floodDetectionData.stats.flood_area_km2} km虏` });
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
    statsRows.push({ label: 'Affected Built-up', value: `${u.affected_area_km2} km虏` });
    statsRows.push({ label: 'Total Built-up', value: `${u.total_area_km2} km虏` });
    if (u.percentage != null) statsRows.push({ label: 'Percentage', value: `${u.percentage}%` });
  }
  if (layerType === 'landcover' && impactData?.landcover && !impactData.landcover.error) {
    const lc = impactData.landcover;
    if (lc.breakdown) {
      Object.entries(lc.breakdown).forEach(([key, val]) => {
        statsRows.push({ label: key.charAt(0).toUpperCase() + key.slice(1), value: `${val.area_km2} km虏` });
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
        <span className="popover-title">{meta.title}</span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>x</button>
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
      i
      {popoverContent}
    </span>
  );
}

function AgentPanel() {
  const { 
    setFloodAgentState, 
    floodAgentState,
    setWarning,
    setAgentImagery,
    setAgentImageryLoading,
    agentImagery,
    agentImageryLoading,
    // Agent control states from context
    agentSelectedPeriod,
    agentSelectedType,
    setAgentSelectedType,
    agentShowBaseImagery,
    setAgentShowBaseImagery,
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
    setAgentTileError,
    businessLayers,
    selectedAOI,
    toggleBusinessLayerVisibility,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
  } = useAppContext();

  // Local UI state (for section expansion only)
  const [expandedSections, setExpandedSections] = useState({
    layerManager: true,
  });

  const { state } = useCoAgent({
    name: "flood_agent",
    initialState: defaultAgentState,
  });

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
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
  const scopeSourceLabel = useCallback((source) => {
    const normalizedSource = String(source || '').toLowerCase();
    if (normalizedSource === 'place_search') return 'place search';
    if (normalizedSource === 'draw') return 'draw';
    if (normalizedSource === 'upload') return 'upload';
    if (normalizedSource === 'edited') return 'edited';
    return normalizedSource || 'scope';
  }, []);
  const selectedPeriodMeta = useMemo(
    () => ({
      pre_date: { label: 'Pre-Flood' },
      peek_date: { label: 'Peak' },
      after_date: { label: 'Post-Flood' },
    }[agentSelectedPeriod] || { label: agentSelectedPeriod || 'Period' }),
    [agentSelectedPeriod]
  );
  const layerManagerGroups = useMemo(() => {
    const groups = [
      {
        key: 'imagery',
        label: 'Imagery',
        items: ['sentinel2', 'sentinel1'].map((type) => {
          const descriptor = agentImagery?.[agentSelectedPeriod]?.[type] || null;
          const isCurrent = agentSelectedType === type;
          const subtitleParts = [selectedPeriodMeta.label];

          if (descriptor?.date) {
            subtitleParts.push(descriptor.date);
          }
          if (descriptor?.resolution) {
            subtitleParts.push(`${descriptor.resolution}m`);
          }

          return {
            id: `base-imagery-${type}`,
            title: type === 'sentinel2' ? 'Optical Imagery' : 'SAR Imagery',
            subtitle: subtitleParts.join(' / '),
            checked: Boolean(isCurrent && agentShowBaseImagery && descriptor?.tile_url),
            disabled: !descriptor?.tile_url,
            loading: Boolean((agentImageryLoading || agentLayerLoading['base-imagery']) && isCurrent),
            badge: isCurrent ? 'Current' : null,
            onToggle: () => {
              if (!descriptor?.tile_url) {
                return;
              }

              setAgentSelectedType(type);
              setAgentShowBaseImagery((previous) => (isCurrent ? !previous : true));
            },
          };
        }),
      },
      {
        key: 'analysis',
        label: 'Analysis',
        items: [
          {
            id: 'analysis-flood-detection',
            title: 'Flood Detection',
            subtitle: analysisDisplayEnabled ? 'Core flood mask generated from Sentinel imagery' : 'Available after event confirmation',
            checked: Boolean(agentShowFloodDetection && analysisDisplayEnabled),
            disabled: !analysisDisplayEnabled,
            loading: Boolean(agentLayerLoading['flood-detection']),
            status: !analysisDisplayEnabled ? 'Unavailable' : (agentShowFloodDetection ? 'Visible' : 'Hidden'),
            tone: !analysisDisplayEnabled ? 'idle' : (agentShowFloodDetection ? 'ready' : 'off'),
            onToggle: () => {
              if (analysisDisplayEnabled) {
                setAgentShowFloodDetection((previous) => !previous);
              }
            },
          },
          {
            id: 'analysis-population',
            title: 'Population Impact',
            subtitle: agentImpactData?.layers?.population?.tile_url
              ? 'WorldPop exposure overlay'
              : 'Impact tiles will load on demand',
            checked: Boolean(agentShowPopulationLayer && analysisDisplayEnabled),
            disabled: !analysisDisplayEnabled,
            loading: Boolean(agentLayerLoading.population || (agentShowPopulationLayer && agentImpactLoading)),
            status: !analysisDisplayEnabled
              ? 'Unavailable'
              : (agentShowPopulationLayer ? 'Visible' : (agentImpactData?.layers?.population?.tile_url ? 'Hidden' : 'Pending')),
            tone: !analysisDisplayEnabled
              ? 'idle'
              : (agentShowPopulationLayer ? 'ready' : (agentImpactData?.layers?.population?.tile_url ? 'off' : 'pending')),
            onToggle: () => {
              if (analysisDisplayEnabled) {
                setAgentShowPopulationLayer((previous) => !previous);
              }
            },
          },
          {
            id: 'analysis-urban',
            title: 'Built-up Area',
            subtitle: agentImpactData?.layers?.urban?.tile_url
              ? 'Built-up footprint impact overlay'
              : 'Impact tiles will load on demand',
            checked: Boolean(agentShowUrbanLayer && analysisDisplayEnabled),
            disabled: !analysisDisplayEnabled,
            loading: Boolean(agentLayerLoading.urban || (agentShowUrbanLayer && agentImpactLoading)),
            status: !analysisDisplayEnabled
              ? 'Unavailable'
              : (agentShowUrbanLayer ? 'Visible' : (agentImpactData?.layers?.urban?.tile_url ? 'Hidden' : 'Pending')),
            tone: !analysisDisplayEnabled
              ? 'idle'
              : (agentShowUrbanLayer ? 'ready' : (agentImpactData?.layers?.urban?.tile_url ? 'off' : 'pending')),
            onToggle: () => {
              if (analysisDisplayEnabled) {
                setAgentShowUrbanLayer((previous) => !previous);
              }
            },
          },
          {
            id: 'analysis-landcover',
            title: 'Land Cover',
            subtitle: agentImpactData?.layers?.landcover?.tile_url
              ? 'ESA WorldCover class overlay'
              : 'Impact tiles will load on demand',
            checked: Boolean(agentShowLandcoverLayer && analysisDisplayEnabled),
            disabled: !analysisDisplayEnabled,
            loading: Boolean(agentLayerLoading.landcover || (agentShowLandcoverLayer && agentImpactLoading)),
            status: !analysisDisplayEnabled
              ? 'Unavailable'
              : (agentShowLandcoverLayer ? 'Visible' : (agentImpactData?.layers?.landcover?.tile_url ? 'Hidden' : 'Pending')),
            tone: !analysisDisplayEnabled
              ? 'idle'
              : (agentShowLandcoverLayer ? 'ready' : (agentImpactData?.layers?.landcover?.tile_url ? 'off' : 'pending')),
            onToggle: () => {
              if (analysisDisplayEnabled) {
                setAgentShowLandcoverLayer((previous) => !previous);
              }
            },
          },
        ],
      },
    ];

    if (confirmedRecommendedCatalogLayers.length > 0) {
      groups.push({
        key: 'recommended',
        label: 'Recommended',
        items: confirmedRecommendedCatalogLayers.map((layer) => {
          const descriptor = agentRecommendedLayerData?.[layer.id] || null;
          const visible = Boolean(agentRecommendedLayerVisibility?.[layer.id]);
          const loading = Boolean(agentLayerLoading?.[layer.id]);
          return {
            id: `recommended-${layer.id}`,
            title: layer.title,
            subtitle: layer.summary || layer.ui_profile?.group_label || 'Recommended catalog layer',
            checked: visible,
            disabled: !analysisDisplayEnabled,
            loading,
            status: !analysisDisplayEnabled
              ? 'Unavailable'
              : (loading ? 'Loading' : (visible ? (descriptor?.tile_url ? 'Visible' : 'Pending') : 'Hidden')),
            tone: !analysisDisplayEnabled
              ? 'idle'
              : (loading ? 'loading' : (visible ? (descriptor?.tile_url ? 'ready' : 'pending') : 'off')),
            badge: layer.ui_profile?.badge_label || null,
            onToggle: () => {
              if (analysisDisplayEnabled) {
                setAgentRecommendedLayerVisibility((previous) => ({
                  ...previous,
                  [layer.id]: !previous[layer.id],
                }));
              }
            },
          };
        }),
      });
    }

    if (businessLayers?.length) {
      groups.push({
        key: 'scopes',
        label: 'Vector Layers',
        items: businessLayers.map((layer) => {
          const isVisible = layer.is_visible !== false;
          return {
            id: `scope-${layer.id}`,
            title: layer.label,
            subtitle: scopeSourceLabel(layer.source),
            checked: isVisible,
            disabled: false,
            loading: false,
            status: isVisible ? 'Visible' : 'Hidden',
            tone: isVisible ? 'ready' : 'off',
            badge: layer.is_active ? 'Current' : null,
            actionLabel: 'Delete',
            onToggle: () => toggleBusinessLayerVisibility(layer.id),
            onSelect: () => activateBusinessLayerRecord(layer.id),
            onAction: () => deleteBusinessLayer(layer.id),
          };
        }),
      });
    }

    return groups.filter((group) => group.items.length > 0);
  }, [
    agentImageryLoading,
    agentImagery,
    agentImpactData,
    agentImpactLoading,
    agentLayerLoading,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentSelectedType,
    agentShowBaseImagery,
    agentShowFloodDetection,
    agentShowLandcoverLayer,
    agentShowPopulationLayer,
    agentShowUrbanLayer,
    analysisDisplayEnabled,
    businessLayers,
    confirmedRecommendedCatalogLayers,
    scopeSourceLabel,
    agentSelectedPeriod,
    selectedPeriodMeta.label,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
    setAgentRecommendedLayerVisibility,
    setAgentSelectedType,
    setAgentShowBaseImagery,
    setAgentShowFloodDetection,
    setAgentShowLandcoverLayer,
    setAgentShowPopulationLayer,
    setAgentShowUrbanLayer,
    toggleBusinessLayerVisibility,
  ]);
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
      });

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
      if (imageryRequestKeyRef.current === requestKey) {
        setAgentImageryLoading(false);
      }
    }
  }, [setAgentImagery, setAgentImageryLoading, setAgentImpactData, setAgentTileError, setWarning]);

  useEffect(() => {
    if (!analysisDisplayEnabled || !currentState.pre_date || !currentState.peek_date || !currentState.after_date) {
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
    setAgentImpactLoading(true);
    setWarning('');
    try {
      const result = await getFloodImpact({
        pre_date: currentState.pre_date,
        peek_date: currentState.peek_date,
        bounds: effectiveAoi?.bounds || currentState.bounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentState.geojson || null,
      });

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
      if (impactRequestKeyRef.current === requestKey) {
        setAgentImpactLoading(false);
      }
    }
  }, [agentImpactData, analysisDisplayEnabled, currentState, effectiveAoi, setAgentImpactData, setAgentImpactLoading, setWarning]);

  // Auto-fetch impact data in background as soon as imagery arrives
  useEffect(() => {
    if (!analysisDisplayEnabled || !currentState.pre_date || !currentState.peek_date) {
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

  // Toggle section expansion
  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  return (
    <div className="agent-panel-controls">
      <div className={`control-section ${expandedSections.layerManager ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('layerManager')}>
          <span className="section-title">Layer Manager</span>
          <span className={`expand-icon ${expandedSections.layerManager ? 'expanded' : ''}`}>v</span>
        </div>
        {expandedSections.layerManager && (
          <div className="section-body layer-manager-body">
            <div className="layer-manager-toolbar">
              <div className="layer-manager-toolbar-label">Search Place</div>
            </div>
            <LocationScopePicker embedded />
            <div className="layer-manager-groups">
              {layerManagerGroups.map((group) => (
                <div className="layer-manager-group" key={group.key}>
                  <div className="layer-manager-group-header">
                    <span className="layer-manager-group-title">{group.label}</span>
                    <span className="layer-manager-group-count">{group.items.length}</span>
                  </div>
                  <div className="layer-manager-items">
                    {group.items.map((item) => (
                      <div
                        className={`layer-manager-item ${item.checked ? 'is-visible' : 'is-hidden'} ${item.disabled ? 'is-disabled' : ''}`}
                        key={item.id}
                      >
                        <div className="layer-manager-item-main">
                          <input
                            type="checkbox"
                            checked={item.checked}
                            onChange={item.onToggle}
                            disabled={item.disabled}
                          />
                          {item.onSelect ? (
                            <button
                              type="button"
                              className="layer-manager-item-trigger"
                              onClick={item.onSelect}
                              disabled={item.disabled}
                            >
                              <div className="layer-manager-item-copy">
                                <div className="layer-manager-item-head">
                                  <span className="layer-manager-item-title">{item.title}</span>
                                  {item.badge ? (
                                    <span className="layer-manager-item-badge">{item.badge}</span>
                                  ) : null}
                                </div>
                                {item.subtitle ? (
                                  <span className="layer-manager-item-subtitle">{item.subtitle}</span>
                                ) : null}
                              </div>
                            </button>
                          ) : (
                            <div className="layer-manager-item-copy">
                              <div className="layer-manager-item-head">
                                <span className="layer-manager-item-title">{item.title}</span>
                                {item.badge ? (
                                  <span className="layer-manager-item-badge">{item.badge}</span>
                                ) : null}
                              </div>
                              {item.subtitle ? (
                                <span className="layer-manager-item-subtitle">{item.subtitle}</span>
                              ) : null}
                            </div>
                          )}
                        </div>
                        <div className="layer-manager-item-side">
                          {item.actionLabel && item.onAction ? (
                            <button
                              type="button"
                              className="layer-manager-item-action"
                              onClick={item.onAction}
                            >
                              {item.actionLabel}
                            </button>
                          ) : null}
                          {item.loading ? (
                            <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
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


