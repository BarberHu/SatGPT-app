/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { Profiler, startTransition, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useCoAgent, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import LocationScopePicker from './LocationScopePicker';
import { getFloodImages, getFloodImpact, renderRecommendedLayer } from '../services/agentApi';
import { buildAoiFromAgentState } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import {
  buildCatalogLegendModel,
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import {
  createReactProfilerHandler,
  startAgentDiagnosticSpan,
  updateAgentDiagnosticsContext,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
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

const formatCoordinatePart = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(6) : '';
};

const buildBoundsSignature = (bounds) => {
  if (!bounds) {
    return 'no-bounds';
  }

  return [
    formatCoordinatePart(bounds.west),
    formatCoordinatePart(bounds.south),
    formatCoordinatePart(bounds.east),
    formatCoordinatePart(bounds.north),
  ].join(':');
};

const buildLayerSignature = (layers = []) => (layers || [])
  .map((layer) => [
    layer?.id || '',
    layer?.layer_family || '',
    layer?.title || '',
    layer?.default_selected ? '1' : '0',
  ].join('~'))
  .join('|');

const buildSelectedLayerSignature = (layerIds = []) => (layerIds || []).join('|');

const buildAoiSignature = (aoi, fallbackBounds = null) => [
  aoi?.id || aoi?.label || aoi?.source || 'aoi',
  buildBoundsSignature(aoi?.bounds || fallbackBounds),
].join('|');

const buildRecommendedLayerContextKey = ({
  confirmationVersion,
  preDate,
  peekDate,
  afterDate,
  aoiSignature,
  layerSignature,
}) => [
  confirmationVersion || 0,
  preDate || '',
  peekDate || '',
  afterDate || '',
  aoiSignature || 'no-aoi',
  layerSignature || 'no-layers',
].join('|');

const areAoiScopesEquivalent = (left, right) => {
  if (!left || !right) {
    return false;
  }

  if (left.id && right.id) {
    return left.id === right.id;
  }

  return buildBoundsSignature(left.bounds) === buildBoundsSignature(right.bounds);
};

const RECOMMENDED_LAYER_MAX_CONCURRENCY = 2;
const EMPTY_ARRAY = [];

const CORE_LAYER_LEGENDS = {
  sentinel2: {
    type: 'text',
    label: 'True color RGB composite',
  },
  sentinel1: {
    type: 'palette',
    label: 'VV backscatter',
    min: '-25 dB',
    max: '0 dB',
    palette: ['#111827', '#64748b', '#f8fafc'],
  },
  flood_detection: {
    type: 'solid',
    label: 'Flood extent',
    color: '#ff0000',
  },
  population: {
    type: 'palette',
    label: 'Population density',
    min: 0,
    max: 1000,
    palette: ['#ffffcc', '#fd8d3c', '#bd0026'],
  },
  urban: {
    type: 'palette',
    label: 'Built-up surface',
    min: 0,
    max: 10000,
    palette: ['#ffeda0', '#feb24c', '#f03b20'],
  },
  landcover: {
    type: 'classes',
    label: 'ESA WorldCover',
    items: [
      { value: 'Tree', color: '#006400' },
      { value: 'Shrub', color: '#ffbb22' },
      { value: 'Grass', color: '#ffff4c' },
      { value: 'Crop', color: '#f096ff' },
      { value: 'Built', color: '#fa0000' },
      { value: 'Water', color: '#0064c8' },
    ],
  },
  vector_scope: {
    type: 'solid',
    label: 'Vector AOI boundary',
    color: '#2563eb',
  },
};

const formatCoordinatePair = (pair) => [
  formatCoordinatePart(pair?.[0]),
  formatCoordinatePart(pair?.[1]),
].join(':');

const buildRingSampleSignature = (ring = []) => {
  const pointCount = Array.isArray(ring) ? ring.length : 0;
  const middleIndex = pointCount ? Math.floor(pointCount / 2) : -1;

  return [
    pointCount,
    formatCoordinatePair(pointCount ? ring[0] : null),
    formatCoordinatePair(pointCount ? ring[middleIndex] : null),
    formatCoordinatePair(pointCount ? ring[pointCount - 1] : null),
  ].join('~');
};

const buildGeometrySampleSignature = (geometry) => {
  if (!geometry || typeof geometry !== 'object') {
    return 'no-geometry';
  }

  switch (geometry.type) {
    case 'Feature':
      return ['Feature', buildGeometrySampleSignature(geometry.geometry)].join('|');
    case 'FeatureCollection':
      return [
        'FeatureCollection',
        Array.isArray(geometry.features) ? geometry.features.length : 0,
        buildGeometrySampleSignature(geometry.features?.[0]),
      ].join('|');
    case 'GeometryCollection':
      return [
        'GeometryCollection',
        Array.isArray(geometry.geometries) ? geometry.geometries.length : 0,
        buildGeometrySampleSignature(geometry.geometries?.[0]),
      ].join('|');
    case 'Polygon':
      return [
        'Polygon',
        Array.isArray(geometry.coordinates) ? geometry.coordinates.length : 0,
        buildRingSampleSignature(geometry.coordinates?.[0]),
      ].join('|');
    case 'MultiPolygon':
      return [
        'MultiPolygon',
        Array.isArray(geometry.coordinates) ? geometry.coordinates.length : 0,
        Array.isArray(geometry.coordinates?.[0]) ? geometry.coordinates[0].length : 0,
        buildRingSampleSignature(geometry.coordinates?.[0]?.[0]),
      ].join('|');
    default:
      return geometry.type || 'unknown-geometry';
  }
};

const buildGeojsonSignature = (geojson, fallbackBounds = null) => {
  const geometry = geojson?.geometry || geojson;
  return [
    buildBoundsSignature(fallbackBounds),
    buildGeometrySampleSignature(geometry),
  ].join('|');
};

const buildAoiObjectSignature = (aoi, fallbackBounds = null) => {
  if (!aoi) {
    return 'no-aoi';
  }

  const bounds = aoi?.bounds || fallbackBounds || null;
  return [
    aoi?.id || '',
    aoi?.label || '',
    aoi?.source || '',
    buildBoundsSignature(bounds),
    buildGeojsonSignature(aoi?.geojson, bounds),
  ].join('|');
};

const buildResolutionMetaSignature = (meta) => {
  if (!meta) {
    return 'no-aoi-resolution-meta';
  }

  return [
    meta.location || '',
    meta.source || '',
    Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence).toFixed(3) : '',
    meta.status || '',
    meta.resolution_rank ?? '',
    buildBoundsSignature(meta.bounds),
  ].join('|');
};

const useStableReference = (value, signature) => {
  const reference = useRef({ signature, value });

  if (reference.current.signature !== signature) {
    reference.current = { signature, value };
  }

  return reference.current.value;
};

function LayerManagerLegend({ legendModel }) {
  if (!legendModel) {
    return null;
  }

  if (legendModel.type === 'classes' && Array.isArray(legendModel.items)) {
    return (
      <div className="layer-manager-legend classes">
        <div className="layer-manager-legend-class-row">
          {legendModel.items.map((item) => (
            <span className="layer-manager-legend-class" key={`${legendModel.label}-${item.value}`}>
              <span
                className="layer-manager-legend-color"
                style={{ backgroundColor: item.color }}
              />
              <span>{item.value}</span>
            </span>
          ))}
        </div>
        <span className="layer-manager-legend-label">{legendModel.label}</span>
      </div>
    );
  }

  if (legendModel.type === 'palette' && Array.isArray(legendModel.palette)) {
    return (
      <div className="layer-manager-legend">
        <span
          className="layer-manager-legend-swatch gradient"
          style={{
            backgroundImage: `linear-gradient(90deg, ${legendModel.palette.join(', ')})`,
          }}
        />
        <span className="layer-manager-legend-label">{legendModel.label}</span>
        {(legendModel.min !== undefined && legendModel.max !== undefined) ? (
          <span className="layer-manager-legend-range">{legendModel.min} - {legendModel.max}</span>
        ) : null}
      </div>
    );
  }

  if (legendModel.type === 'solid') {
    return (
      <div className="layer-manager-legend">
        <span
          className="layer-manager-legend-swatch solid"
          style={{ backgroundColor: legendModel.color }}
        />
        <span className="layer-manager-legend-label">{legendModel.label}</span>
      </div>
    );
  }

  return (
    <div className="layer-manager-legend text">
      <span className="layer-manager-legend-label">{legendModel.label}</span>
    </div>
  );
}

function LayerManagerItemCopy({ item }) {
  const tooltipDetails = Array.isArray(item.infoDetails)
    ? item.infoDetails.filter((detail) => detail?.label && detail?.value)
    : [];

  return (
    <div className="layer-manager-item-copy">
      <div className="layer-manager-item-head">
        <span className="layer-manager-item-title">{item.title}</span>
        {item.infoText ? (
          <span className="layer-manager-item-info-wrap">
            <span
              className="layer-manager-item-info"
              aria-label={item.infoText}
            >
              !
            </span>
            <span className="layer-manager-item-tooltip" role="tooltip">
              <span className="layer-manager-tooltip-title">{item.infoText}</span>
              {tooltipDetails.length > 0 ? (
                <span className="layer-manager-tooltip-details">
                  {tooltipDetails.map((detail) => (
                    <span className="layer-manager-tooltip-row" key={`${detail.label}-${detail.value}`}>
                      <span className="layer-manager-tooltip-key">{detail.label}</span>
                      <span className="layer-manager-tooltip-value">{detail.value}</span>
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </div>
      <LayerManagerLegend legendModel={item.legend} />
      {item.detailText ? (
        <div className="layer-manager-item-detail">{item.detailText}</div>
      ) : null}
    </div>
  );
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
  const hasCoAgentState = Boolean(state);
  const rawState = hasCoAgentState ? state : floodAgentState;
  const rawEvent = rawState?.event || null;
  const rawPreDate = rawState?.pre_date || null;
  const rawAfterDate = rawState?.after_date || null;
  const rawPeekDate = rawState?.peek_date || null;
  const rawLocation = rawState?.location || null;
  const rawCoordinates = rawState?.coordinates || null;
  const rawBounds = rawState?.bounds || null;
  const rawGeojson = rawState?.geojson || null;
  const rawResolvedAoi = rawState?.resolved_aoi || null;
  const rawAoiResolutionMeta = rawState?.aoi_resolution_meta || null;
  const rawConfirmedAoi = rawState?.confirmed_aoi || null;
  const rawRecommendedLayers = Array.isArray(rawState?.recommended_layers)
    ? rawState.recommended_layers
    : EMPTY_ARRAY;
  const rawSelectedLayerIds = Array.isArray(rawState?.selected_layer_ids)
    ? rawState.selected_layer_ids
    : EMPTY_ARRAY;
  const rawConfirmationVersion = rawState?.confirmation_version || 0;
  const rawGeeCode = rawState?.gee_code || null;
  const rawPreferredAoi = rawState?.confirmed_aoi || rawState?.resolved_aoi || null;
  const rawBoundsSignature = buildBoundsSignature(rawPreferredAoi?.bounds || rawState?.bounds);
  const rawGeojsonSignature = buildGeojsonSignature(rawGeojson, rawBounds);
  const rawResolvedAoiSignature = buildAoiObjectSignature(rawResolvedAoi, rawBounds);
  const rawConfirmedAoiSignature = buildAoiObjectSignature(rawConfirmedAoi, rawBounds);
  const rawAoiResolutionMetaSignature = buildResolutionMetaSignature(rawAoiResolutionMeta);
  const rawRecommendedLayerSignature = buildLayerSignature(rawRecommendedLayers);
  const rawSelectedLayerSignature = buildSelectedLayerSignature(rawSelectedLayerIds);
  const rawCoordinatesSignature = [
    formatCoordinatePart(rawCoordinates?.[0]),
    formatCoordinatePart(rawCoordinates?.[1]),
  ].join(':');
  const stableCoordinates = useStableReference(rawCoordinates, rawCoordinatesSignature);
  const stableBounds = useStableReference(rawBounds, rawBoundsSignature);
  const stableGeojson = useStableReference(rawGeojson, rawGeojsonSignature);
  const stableResolvedAoi = useStableReference(rawResolvedAoi, rawResolvedAoiSignature);
  const stableAoiResolutionMeta = useStableReference(rawAoiResolutionMeta, rawAoiResolutionMetaSignature);
  const stableConfirmedAoi = useStableReference(rawConfirmedAoi, rawConfirmedAoiSignature);
  const stableRecommendedLayers = useStableReference(rawRecommendedLayers, rawRecommendedLayerSignature);
  const stableSelectedLayerIds = useStableReference(rawSelectedLayerIds, rawSelectedLayerSignature);
  const currentState = useMemo(
    () => ({
      ...defaultAgentState,
      event: rawEvent,
      pre_date: rawPreDate,
      after_date: rawAfterDate,
      peek_date: rawPeekDate,
      location: rawLocation,
      coordinates: stableCoordinates,
      bounds: stableBounds,
      geojson: stableGeojson,
      resolved_aoi: stableResolvedAoi,
      confirmed_aoi: stableConfirmedAoi,
      recommended_layers: stableRecommendedLayers,
      selected_layer_ids: stableSelectedLayerIds,
      confirmation_version: rawConfirmationVersion,
      gee_code: rawGeeCode,
    }),
    [
      rawEvent,
      rawPreDate,
      rawAfterDate,
      rawPeekDate,
      rawLocation,
      stableCoordinates,
      stableBounds,
      stableGeojson,
      stableResolvedAoi,
      stableConfirmedAoi,
      stableRecommendedLayers,
      stableSelectedLayerIds,
      rawGeeCode,
      rawConfirmationVersion,
    ]
  );

  const sharedAgentState = useMemo(
    () => ({
      ...defaultAgentState,
      location: rawLocation,
      coordinates: stableCoordinates,
      bounds: stableBounds,
      geojson: stableGeojson,
      resolved_aoi: stableResolvedAoi,
      aoi_resolution_meta: stableAoiResolutionMeta,
      confirmed_aoi: stableConfirmedAoi,
      confirmation_version: rawConfirmationVersion,
    }),
    [
      rawLocation,
      stableCoordinates,
      stableBounds,
      stableGeojson,
      stableResolvedAoi,
      stableAoiResolutionMeta,
      stableConfirmedAoi,
      rawConfirmationVersion,
    ]
  );

  useEffect(() => {
    if (hasCoAgentState) {
      startTransition(() => {
        setFloodAgentState(sharedAgentState);
      });
    }
  }, [hasCoAgentState, setFloodAgentState, sharedAgentState]);

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
  const currentSelectedLayerSignature = buildSelectedLayerSignature(currentSelectedLayerIds);
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
  const recommendedCatalogLayers = useMemo(
    () => sortCatalogLayers(
      currentRecommendedLayers.filter((layer) => layer.layer_family === 'catalog')
    ),
    [currentRecommendedLayers]
  );
  const confirmedRecommendedCatalogLayers = useMemo(() => {
    const confirmedIds = new Set(currentSelectedLayerIds);
    return recommendedCatalogLayers.filter((layer) => confirmedIds.has(layer.id));
  }, [currentSelectedLayerIds, recommendedCatalogLayers]);
  const effectiveAoiSignature = buildAoiSignature(effectiveAoi, currentBounds);
  const recommendedLayerContextKey = useMemo(() => buildRecommendedLayerContextKey({
    confirmationVersion: currentConfirmationVersion,
    preDate: currentPreDate,
    peekDate: currentPeekDate,
    afterDate: currentAfterDate,
    aoiSignature: effectiveAoiSignature,
    layerSignature: currentRecommendedLayerSignature,
  }), [
    currentConfirmationVersion,
    currentPreDate,
    currentPeekDate,
    currentAfterDate,
    currentRecommendedLayerSignature,
    effectiveAoiSignature,
  ]);
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
      recommendedLayerContextKey,
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
    recommendedLayerContextKey,
  ]);

  const layerManagerGroups = useMemo(() => {
    const getAnalysisLayerStatus = (isVisible, hasTile = true) => {
      if (!analysisDisplayEnabled) {
        return 'Unavailable';
      }
      if (isVisible) {
        return 'Visible';
      }
      return hasTile ? 'Ready' : 'Pending';
    };

    const groups = [
      {
        key: 'imagery',
        label: 'Imagery',
        items: ['sentinel2', 'sentinel1'].map((type) => {
          const descriptor = agentImagery?.[agentSelectedPeriod]?.[type] || null;
          const isCurrent = agentSelectedType === type;
          const isAvailable = Boolean(descriptor?.tile_url);

          return {
            id: `base-imagery-${type}`,
            title: type === 'sentinel2' ? 'Optical Imagery' : 'SAR Imagery',
            infoText: type === 'sentinel2'
              ? 'Optical base imagery for visual flood context'
              : 'SAR base imagery for cloud-resistant flood context',
            infoDetails: [
              { label: 'Source', value: type === 'sentinel2' ? 'Sentinel-2 RGB' : 'Sentinel-1 GRD' },
              { label: 'Period', value: selectedPeriodMeta.label },
              { label: 'Date', value: descriptor?.date },
              { label: 'Resolution', value: descriptor?.resolution ? `${descriptor.resolution}m` : null },
              { label: 'Status', value: isAvailable ? (isCurrent ? 'Current' : 'Available') : 'Unavailable' },
            ],
            legend: CORE_LAYER_LEGENDS[type],
            checked: Boolean(isCurrent && agentShowBaseImagery && isAvailable),
            disabled: !isAvailable,
            loading: Boolean((agentImageryLoading || agentLayerLoading['base-imagery']) && isCurrent),
            badge: isCurrent ? 'Current' : null,
            onToggle: () => {
              if (!isAvailable) {
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
            infoText: analysisDisplayEnabled ? LAYER_META.flood_detection.description : 'Available after event confirmation',
            infoDetails: [
              { label: 'Source', value: LAYER_META.flood_detection.source },
              { label: 'Method', value: LAYER_META.flood_detection.method },
              { label: 'Resolution', value: LAYER_META.flood_detection.resolution },
              { label: 'Status', value: getAnalysisLayerStatus(agentShowFloodDetection) },
            ],
            legend: CORE_LAYER_LEGENDS.flood_detection,
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
            infoText: LAYER_META.population.description,
            infoDetails: [
              { label: 'Source', value: LAYER_META.population.source },
              { label: 'Method', value: LAYER_META.population.method },
              { label: 'Resolution', value: LAYER_META.population.resolution },
              { label: 'Status', value: getAnalysisLayerStatus(agentShowPopulationLayer, agentImpactData?.layers?.population?.tile_url) },
            ],
            legend: CORE_LAYER_LEGENDS.population,
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
            infoText: LAYER_META.urban.description,
            infoDetails: [
              { label: 'Source', value: LAYER_META.urban.source },
              { label: 'Method', value: LAYER_META.urban.method },
              { label: 'Resolution', value: LAYER_META.urban.resolution },
              { label: 'Status', value: getAnalysisLayerStatus(agentShowUrbanLayer, agentImpactData?.layers?.urban?.tile_url) },
            ],
            legend: CORE_LAYER_LEGENDS.urban,
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
            infoText: LAYER_META.landcover.description,
            infoDetails: [
              { label: 'Source', value: LAYER_META.landcover.source },
              { label: 'Method', value: LAYER_META.landcover.method },
              { label: 'Resolution', value: LAYER_META.landcover.resolution },
              { label: 'Status', value: getAnalysisLayerStatus(agentShowLandcoverLayer, agentImpactData?.layers?.landcover?.tile_url) },
            ],
            legend: CORE_LAYER_LEGENDS.landcover,
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
            infoText: layer.summary || layer.ui_profile?.group_label || 'Recommended catalog layer',
            infoDetails: [
              { label: 'Group', value: layer.ui_profile?.group_label || layer.product_group },
              { label: 'Source', value: descriptor?.source_meta?.title || layer.source_meta?.title },
              { label: 'Status', value: !analysisDisplayEnabled ? 'Unavailable' : (loading ? 'Loading' : (visible ? (descriptor?.tile_url ? 'Visible' : 'Pending') : 'Hidden')) },
            ],
            legend: buildCatalogLegendModel(descriptor || layer, layer.title),
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
            detailText: scopeSourceLabel(layer.source),
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
    if (!analysisDisplayEnabled || !currentRecommendedLayers.length) {
      setAgentRecommendedLayerVisibility({});
      setAgentRecommendedLayerData({});
      return;
    }

    setAgentRecommendedLayerVisibility(() => {
      const next = {};
      currentRecommendedLayers.forEach((layer) => {
        next[layer.id] = currentSelectedLayerIds.includes(layer.id);
      });
      return next;
    });
  }, [
    analysisDisplayEnabled,
    currentConfirmationVersion,
    currentRecommendedLayers,
    currentSelectedLayerIds,
    currentRecommendedLayerSignature,
    currentSelectedLayerSignature,
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

    const selectedIds = currentSelectedLayerIds;
    setAgentShowFloodDetection(selectedIds.includes('core:flood_detection'));
    setAgentShowPopulationLayer(selectedIds.includes('core:population'));
    setAgentShowUrbanLayer(selectedIds.includes('core:urban'));
    setAgentShowLandcoverLayer(selectedIds.includes('core:landcover'));
  }, [
    analysisDisplayEnabled,
    currentSelectedLayerIds,
    currentSelectedLayerSignature,
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
    const requestKey = [
      agentState.pre_date || '',
      agentState.peek_date || '',
      agentState.after_date || '',
      buildAoiSignature(aoi, agentState.bounds),
      formatCoordinatePart(agentState.coordinates?.[0]),
      formatCoordinatePart(agentState.coordinates?.[1]),
    ].join('|');

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

    const finishImagerySpan = startAgentDiagnosticSpan('network', 'flood_images', {
      requestKey,
      aoiSource: aoi?.source || 'agent',
      hasBounds: Boolean(aoi?.bounds || agentState.bounds),
      hasGeojson: Boolean(aoi?.geojson?.geometry || agentState.geojson?.geometry),
      preDate: agentState.pre_date || null,
      peekDate: agentState.peek_date || null,
      afterDate: agentState.after_date || null,
    });

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
        finishImagerySpan({ status: 'stale' });
        return;
      }

      if (result?.success) {
        setAgentImagery(result.data);
        setWarning('');
        finishImagerySpan({
          status: 'success',
          hasFloodDetection: Boolean(result?.data?.flood_detection),
          periods: Object.keys(result?.data || {}).filter((key) => key.endsWith('_date')),
        });
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
      finishImagerySpan({
        status: 'error',
        error: error?.message || 'unknown',
      });
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
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate || !currentAfterDate) {
      imageryRequestKeyRef.current = null;
      return;
    }

    if (effectiveAoi || currentCoordinates) {
      fetchAgentImagery({
        pre_date: currentPreDate,
        peek_date: currentPeekDate,
        after_date: currentAfterDate,
        coordinates: currentCoordinates,
        bounds: currentBounds,
        geojson: currentGeojson,
      }, effectiveAoi);
    }
  }, [
    analysisDisplayEnabled,
    currentAfterDate,
    currentBounds,
    currentCoordinates,
    currentGeojson,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
    fetchAgentImagery,
  ]);

  // Fetch flood impact assessment data
  const fetchImpactData = useCallback(async () => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate) return;

    const requestKey = [
      currentPreDate || '',
      currentPeekDate || '',
      effectiveAoiSignature,
    ].join('|');

    if (impactRequestKeyRef.current === requestKey && agentImpactData) {
      return;
    }
    
    impactRequestKeyRef.current = requestKey;
    setAgentImpactLoading(true);
    setWarning('');
    const finishImpactSpan = startAgentDiagnosticSpan('network', 'flood_impact', {
      requestKey,
      aoiSource: effectiveAoi?.source || 'agent',
      hasBounds: Boolean(effectiveAoi?.bounds || currentBounds),
      hasGeojson: Boolean(effectiveAoi?.geojson?.geometry || currentGeojson),
      preDate: currentPreDate || null,
      peekDate: currentPeekDate || null,
    });
    try {
      const result = await getFloodImpact({
        pre_date: currentPreDate,
        peek_date: currentPeekDate,
        bounds: effectiveAoi?.bounds || currentBounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentGeojson || null,
      });

      if (impactRequestKeyRef.current !== requestKey) {
        finishImpactSpan({ status: 'stale' });
        return;
      }

      if (result.success) {
        setAgentImpactData(result.data);
        setWarning('');
        finishImpactSpan({
          status: 'success',
          keys: Object.keys(result?.data || {}),
        });
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
      finishImpactSpan({
        status: 'error',
        error: error?.message || 'unknown',
      });
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
  }, [
    agentImpactData,
    analysisDisplayEnabled,
    currentBounds,
    currentGeojson,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
    effectiveAoiSignature,
    setAgentImpactData,
    setAgentImpactLoading,
    setWarning,
  ]);

  // Auto-fetch impact data in background as soon as imagery arrives
  useEffect(() => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate) {
      impactRequestKeyRef.current = null;
      return;
    }

    if (agentImagery && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentImagery, agentImpactData, agentImpactLoading, analysisDisplayEnabled, currentPeekDate, currentPreDate, fetchImpactData]);

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
      const finishLayerSpan = startAgentDiagnosticSpan('layer', 'render_recommended_layer', {
        requestToken,
        layerId: layer.id,
        layerTitle: layer.title || layer.id,
      });

      pendingRecommendedLayerRequestsRef.current.add(requestToken);
      setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: true }));

      try {
        const result = await renderRecommendedLayer({
          layer_id: layer.id,
          recommended_layers: currentRecommendedLayers,
          confirmed_aoi: effectiveAoi,
          pre_date: currentPreDate,
          peek_date: currentPeekDate,
          after_date: currentAfterDate,
        });

        if (cancelled || !result?.success) {
          finishLayerSpan({ status: cancelled ? 'cancelled' : 'unsuccessful' });
          return;
        }

        setAgentRecommendedLayerData((previous) => ({
          ...previous,
          [layer.id]: {
            ...result.data,
            context_key: recommendedLayerContextKey,
          },
        }));
        finishLayerSpan({
          status: 'success',
          hasTileUrl: Boolean(result?.data?.tile_url),
        });
      } catch (error) {
        if (!cancelled) {
          setWarning(error?.message || 'Failed to render recommended layer.');
        }
        finishLayerSpan({
          status: cancelled ? 'cancelled' : 'error',
          error: error?.message || 'unknown',
        });
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
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    currentRecommendedLayers,
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
    <Profiler id="AgentPanel" onRender={panelProfiler}>
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
                                <LayerManagerItemCopy item={item} />
                              </button>
                            ) : (
                              <LayerManagerItemCopy item={item} />
                            )}
                          </div>
                          <div className="layer-manager-item-side">
                            {item.badge ? (
                              <span className="layer-manager-item-badge">{item.badge}</span>
                            ) : null}
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
            className={`submit btn download ${!currentGeeCode ? 'disabled' : ''}`}
            onClick={() => {
              if (!currentGeeCode) {
                return;
              }
              trackUxEvent('export_gee_code', {
                event: currentEvent || null,
                mode: 'agent',
              });
              downloadGEECode(currentGeeCode, currentEvent);
            }}
            style={{
              cursor: currentGeeCode ? 'pointer' : 'not-allowed',
              opacity: currentGeeCode ? 1 : 0.5,
              pointerEvents: currentGeeCode ? 'auto' : 'none',
            }}
          >
            DOWNLOAD GEE CODE
          </button>
        </div>
      </div>
    </Profiler>
  );
}

export default AgentPanel;


