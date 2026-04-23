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
  getCatalogMapLayerId,
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

// Flood Agent 共享状态的本地默认值。
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
  lclu_raster: {
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
  population_density: {
    type: 'palette',
    label: 'Population density',
    min: 0,
    max: 1000,
    palette: ['#ffffe7', '#ffac1d', '#f2552c', '#9f0c21'],
  },
  soil_texture: {
    type: 'text',
    label: 'Soil texture classes',
  },
  healthcare_access: {
    type: 'palette',
    label: 'Access time',
    min: 0,
    max: '>1000 min',
    palette: ['#fff8dc', '#deb887', '#cd853f', '#8b4513'],
  },
};

const AGENT_RASTER_LAYER_CONFIG = [
  {
    key: 'populationDensity',
    orderId: 'agent-raster-populationDensity',
    title: 'Population Density',
    infoText: 'WorldPop gridded population density for rapid exposure context.',
    legend: CORE_LAYER_LEGENDS.population_density,
  },
  {
    key: 'lclu',
    orderId: 'agent-raster-lclu',
    title: 'LCLU',
    infoText: 'ESA WorldCover land cover classification clipped to the selected AOI.',
    legend: CORE_LAYER_LEGENDS.lclu_raster,
  },
  {
    key: 'soilTexture',
    orderId: 'agent-raster-soilTexture',
    title: 'Soil Texture',
    infoText: 'Soil texture class layer for infiltration and runoff context.',
    legend: CORE_LAYER_LEGENDS.soil_texture,
  },
  {
    key: 'healthCareAccess',
    orderId: 'agent-raster-healthCareAccess',
    title: 'Healthcare Access',
    infoText: 'Travel-time accessibility surface to nearby healthcare services.',
    legend: CORE_LAYER_LEGENDS.healthcare_access,
  },
];

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
        <span className="layer-manager-legend-swatch gradient">
          <span
            className="layer-manager-legend-swatch-fill"
            style={{
              backgroundImage: `linear-gradient(90deg, ${legendModel.palette.join(', ')})`,
            }}
          />
        </span>
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

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function InlineInfoTooltip({ text, details }) {
  const [visible, setVisible] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({
    top: 0,
    left: 0,
    width: 280,
    '--tooltip-arrow-left': '24px',
  });
  const triggerRef = useRef(null);
  const tooltipDetails = useMemo(
    () => (Array.isArray(details)
      ? details.filter((detail) => detail?.label && detail?.value)
      : []),
    [details]
  );

  const updatePopoverPosition = useCallback(() => {
    if (!triggerRef.current) {
      return;
    }

    const rect = triggerRef.current.getBoundingClientRect();
    const viewportPadding = 10;
    const width = Math.min(280, Math.max(220, window.innerWidth - (viewportPadding * 2)));
    const estimatedHeight = tooltipDetails.length > 2 || String(text || '').length > 72 ? 180 : 138;
    const left = clamp(
      rect.left - 18,
      viewportPadding,
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
    );
    let top = rect.bottom + 10;

    if (top + estimatedHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, rect.top - estimatedHeight - 10);
    }

    const arrowLeft = clamp(rect.left + (rect.width / 2) - left, 16, width - 16);
    setPopoverStyle({
      top,
      left,
      width,
      '--tooltip-arrow-left': `${arrowLeft}px`,
    });
  }, [text, tooltipDetails]);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    updatePopoverPosition();
    const handleReposition = () => updatePopoverPosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [visible, updatePopoverPosition]);

  const popoverContent = visible ? createPortal(
    <span
      className="layer-manager-item-tooltip-popover"
      role="tooltip"
      style={popoverStyle}
    >
      <span className="layer-manager-tooltip-title">{text}</span>
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
    </span>,
    document.body
  ) : null;

  return (
    <span className="layer-manager-item-info-wrap">
      <span
        ref={triggerRef}
        className="layer-manager-item-info"
        aria-label={text}
        tabIndex={0}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
      >
        !
      </span>
      {popoverContent}
    </span>
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
          <InlineInfoTooltip text={item.infoText} details={tooltipDetails} />
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
 * 影像信息图标弹层。
 * 展示三个时段的影像来源、日期、轨道与拼接统计，方便判断分析底图是否可靠。
 */
// eslint-disable-next-line no-unused-vars
function ImageryInfoIcon({ imageryData, type, selectedPeriod }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  // 点击弹层外部区域时关闭 popover。
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

  // 复制影像 ID，优先使用 Clipboard API。
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

  // 计算 popover 位置。
  const handleTogglePopover = (e) => {
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const popoverWidth = 290;
      const popoverHeight = 380;
      // 默认优先显示在图标右侧。
      let left = rect.right + 8;
      let top = rect.top - 10;
      // 右侧空间不足时切换到左侧。
      if (left + popoverWidth > window.innerWidth - 10) {
        left = rect.left - popoverWidth - 8;
      }
      // 如果左侧也放不下，就退化为视口内居中。
      if (left < 10) {
        left = Math.max(10, (window.innerWidth - popoverWidth) / 2);
      }
      // 垂直方向超出视口时向上收缩。
      if (top + popoverHeight > window.innerHeight - 10) {
        top = window.innerHeight - popoverHeight - 10;
      }
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // 当前时段对应的影像信息。
  const currentPeriodData = imageryData?.[selectedPeriod]?.[type];
  const hasError = currentPeriodData?.error;

  // 汇总三个时期的影像状态，用于弹层展示。
  const allPeriodsInfo = [
    { key: 'pre_date', label: 'Pre-Flood' },
    { key: 'peek_date', label: 'Peak' },
    { key: 'after_date', label: 'Post-Flood' },
  ].map(({ key, label }) => ({
    key,
    label,
    data: imageryData?.[key]?.[type],
  }));

  // 统计缺影像的时期数量，用于图标状态提示。
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
                      {copiedId === data.id ? 'Copied!' : data.id}
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
 * Analysis Layer 信息图标，展示每个分析图层的数据来源与统计摘要。
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
    agentRasterLoading,
    agentLayerOrder,
    setAgentLayerOrder,
    agentLayerLoading,
    setAgentLayerLoading,
    setAgentTileError,
    businessLayers,
    selectedAOI,
    toggleBusinessLayerVisibility,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
  } = useAppContext();

  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [dragOverState, setDragOverState] = useState({ groupKey: null, targetLayerId: null, position: 'before' });

  const { state } = useCoAgent({
    name: "flood_agent",
    initialState: defaultAgentState,
  });

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
  const pendingRecommendedLayerRequestsRef = useRef(new Set());
  const agentRecommendedLayerDataRef = useRef(agentRecommendedLayerData);
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

  useEffect(() => {
    agentRecommendedLayerDataRef.current = agentRecommendedLayerData;
  }, [agentRecommendedLayerData]);

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

  const orderLayerManagerItems = useCallback((items) => {
    const orderIndex = new Map((agentLayerOrder || []).map((layerId, index) => [layerId, index]));
    return [...items].sort((left, right) => {
      const leftIndex = orderIndex.has(left.orderId) ? orderIndex.get(left.orderId) : Number.MAX_SAFE_INTEGER;
      const rightIndex = orderIndex.has(right.orderId) ? orderIndex.get(right.orderId) : Number.MAX_SAFE_INTEGER;

      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return left.defaultOrder - right.defaultOrder;
    });
  }, [agentLayerOrder]);

  const handleLayerDragStart = useCallback((event, layerId) => {
    if (!layerId) {
      return;
    }

    if (event.target instanceof Element && event.target.closest('input, button, a, select, textarea, label')) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', layerId);
    setDraggedLayerId(layerId);
  }, []);

  const reorderVisibleOverlayLayers = useCallback((sourceLayerId, visibleOrderIds, targetLayerId, position = 'before') => {
    if (!sourceLayerId || !Array.isArray(visibleOrderIds) || !visibleOrderIds.includes(sourceLayerId)) {
      return;
    }

    setAgentLayerOrder((previous) => {
      const visibleSet = new Set(visibleOrderIds);
      const nextVisible = visibleOrderIds.filter((layerId) => layerId !== sourceLayerId);
      const targetIndex = nextVisible.indexOf(targetLayerId);

      if (targetIndex < 0) {
        return previous;
      }

      const insertionIndex = position === 'after' ? targetIndex + 1 : targetIndex;
      nextVisible.splice(insertionIndex, 0, sourceLayerId);
      const hidden = previous.filter((layerId) => !visibleSet.has(layerId));
      return [...nextVisible, ...hidden];
    });
  }, [setAgentLayerOrder]);

  const resolveDropPosition = useCallback((event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (event.clientY - bounds.top) >= (bounds.height / 2) ? 'after' : 'before';
  }, []);

  const handleLayerDragOver = useCallback((event, groupKey, targetLayerId) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverState({
      groupKey,
      targetLayerId,
      position: resolveDropPosition(event),
    });
  }, [resolveDropPosition]);

  const handleLayerDrop = useCallback((event, groupKey, visibleOrderIds, targetLayerId) => {
    event.preventDefault();
    const sourceLayerId = event.dataTransfer.getData('text/plain') || draggedLayerId;
    const position = resolveDropPosition(event);

    if (sourceLayerId && targetLayerId && sourceLayerId !== targetLayerId) {
      reorderVisibleOverlayLayers(sourceLayerId, visibleOrderIds, targetLayerId, position);
    }

    setDraggedLayerId(null);
    setDragOverState({ groupKey: null, targetLayerId: null, position: 'before' });
  }, [draggedLayerId, reorderVisibleOverlayLayers, resolveDropPosition]);

  const handleLayerDragEnd = useCallback(() => {
    setDraggedLayerId(null);
    setDragOverState({ groupKey: null, targetLayerId: null, position: 'before' });
  }, []);

  const layerManagerGroups = useMemo(() => {
    const imageryGroup = {
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
            loading: Boolean((agentImageryLoading || agentLayerLoading['base-imagery']) && isCurrent && agentShowBaseImagery),
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
    };

    const rasterItems = AGENT_RASTER_LAYER_CONFIG.map((layer, index) => {
      const descriptor = layerData?.[layer.key] || null;
      const visible = Boolean(agentRasterLayerVisibility?.[layer.key]);
      const hasScope = Boolean(selectedAOI);
      const hasTile = Boolean(descriptor?.tileUrl);
      const loading = Boolean(hasScope && agentRasterLoading && !hasTile);

      return {
        id: `raster-${layer.key}`,
        orderId: layer.orderId,
        defaultOrder: 10 + index,
        draggable: true,
        title: layer.title,
        infoText: layer.infoText,
        infoDetails: [
          { label: 'Source', value: hasScope ? 'Ask raster service' : 'Select a vector scope first' },
          { label: 'Scope', value: selectedAOI?.label || 'No active scope' },
          { label: 'Status', value: !hasScope ? 'Unavailable' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Pending'))) },
        ],
        legend: layer.legend,
        checked: visible,
        disabled: !hasScope,
        loading,
        checkboxState: !hasScope ? 'idle' : (loading ? 'loading' : (hasTile ? 'ready' : 'idle')),
        status: !hasScope ? 'Unavailable' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Pending'))),
        tone: !hasScope ? 'idle' : (loading ? 'loading' : (visible ? (hasTile ? 'ready' : 'pending') : (hasTile ? 'off' : 'pending'))),
        onToggle: () => {
          if (!hasScope) {
            return;
          }
          setAgentRasterLayerVisibility((previous) => ({
            ...previous,
            [layer.key]: !previous?.[layer.key],
          }));
        },
      };
    });

    const recommendedItems = confirmedRecommendedCatalogLayers.map((layer, index) => {
      const descriptor = agentRecommendedLayerData?.[layer.id] || null;
      const visible = Boolean(agentRecommendedLayerVisibility?.[layer.id]);
      const loading = Boolean(visible && agentLayerLoading?.[layer.id]);
      const orderId = getCatalogMapLayerId(layer.id);
      return {
        id: `recommended-${layer.id}`,
        orderId,
        defaultOrder: 100 + index,
        draggable: true,
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
    });

    const overlayItems = orderLayerManagerItems([
      ...rasterItems,
      ...recommendedItems,
    ]);

    const groups = [];

    if (overlayItems.length > 0) {
      groups.push({
        key: 'overlays',
        label: 'Raster Layers',
        items: overlayItems,
      });
    }

    groups.push(imageryGroup);

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
    agentLayerLoading,
    agentRasterLayerVisibility,
    agentRasterLoading,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentSelectedType,
    agentShowBaseImagery,
    analysisDisplayEnabled,
    businessLayers,
    confirmedRecommendedCatalogLayers,
    layerData,
    orderLayerManagerItems,
    scopeSourceLabel,
    agentSelectedPeriod,
    selectedPeriodMeta.label,
    selectedAOI,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
    setAgentRasterLayerVisibility,
    setAgentRecommendedLayerVisibility,
    setAgentSelectedType,
    setAgentShowBaseImagery,
    toggleBusinessLayerVisibility,
  ]);
  useEffect(() => {
    if (!analysisDisplayEnabled || !currentRecommendedLayers.length) {
      setAgentRecommendedLayerVisibility({});
      setAgentRecommendedLayerData({});
      setAgentLayerOrder((previous) => previous.filter((layerId) => !String(layerId).startsWith('agent-rec-')));
      return;
    }

    const catalogLayerOrderIds = currentRecommendedLayers
      .filter((layer) => layer.layer_family === 'catalog')
      .map((layer) => getCatalogMapLayerId(layer.id));

    setAgentLayerOrder((previous) => {
      const filtered = previous.filter((layerId) => (
        !String(layerId).startsWith('agent-rec-') || catalogLayerOrderIds.includes(layerId)
      ));
      const missing = catalogLayerOrderIds.filter((layerId) => !filtered.includes(layerId));
      return [...filtered, ...missing];
    });

    setAgentRecommendedLayerVisibility(() => {
      const next = {};
      currentRecommendedLayers.forEach((layer) => {
        next[layer.id] = false;
      });
      return next;
    });
  }, [
    analysisDisplayEnabled,
    currentConfirmationVersion,
    currentRecommendedLayers,
    currentRecommendedLayerSignature,
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

    setAgentShowFloodDetection(false);
    setAgentShowPopulationLayer(false);
    setAgentShowUrbanLayer(false);
    setAgentShowLandcoverLayer(false);
  }, [
    analysisDisplayEnabled,
    currentConfirmationVersion,
    currentRecommendedLayerSignature,
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
    const visibleCatalogLayers = confirmedRecommendedCatalogLayers.filter((layer) => agentRecommendedLayerVisibility[layer.id]);
    if (!analysisDisplayEnabled || !visibleCatalogLayers.length || !effectiveAoi) {
      return;
    }

    let cancelled = false;
    const pendingRecommendedLayerRequests = pendingRecommendedLayerRequestsRef.current;
    const layersToRender = visibleCatalogLayers.filter((layer) => {
      const cached = agentRecommendedLayerDataRef.current?.[layer.id];
      const requestToken = `${recommendedLayerContextKey}:${layer.id}`;
      return !(
        (cached?.tile_url && cached?.context_key === recommendedLayerContextKey)
        || pendingRecommendedLayerRequests.has(requestToken)
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

      pendingRecommendedLayerRequests.add(requestToken);
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
        pendingRecommendedLayerRequests.delete(requestToken);
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
      layersToRender.forEach((layer) => {
        pendingRecommendedLayerRequests.delete(`${recommendedLayerContextKey}:${layer.id}`);
      });
      setAgentLayerLoading((previous) => {
        let changed = false;
        const next = { ...previous };
        layersToRender.forEach((layer) => {
          if (next[layer.id]) {
            next[layer.id] = false;
            changed = true;
          }
        });
        return changed ? next : previous;
      });
    };
  }, [
    agentRecommendedLayerVisibility,
    analysisDisplayEnabled,
    confirmedRecommendedCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    currentRecommendedLayers,
    effectiveAoi,
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

  return (
    <Profiler id="AgentPanel" onRender={panelProfiler}>
      <div className="agent-panel-controls">
        <section className="agent-panel-section">
          <div className="section-header agent-panel-section-header">
            <span className="section-title">Layer Manager</span>
          </div>
          <div className="agent-panel-section-body layer-manager-body">
            <div className="layer-manager-groups">
              {layerManagerGroups.map((group) => (
                <section className="layer-manager-group" key={group.key}>
                  <div className="layer-manager-group-header">
                    <span className="layer-manager-group-title">{group.label}</span>
                    <span className="layer-manager-group-count">{group.items.length}</span>
                  </div>
                  <div className="layer-manager-items">
                    {group.items.map((item) => {
                        const visibleOrderIds = group.items.filter((entry) => entry.draggable).map((entry) => entry.orderId);
                        const canReceiveDrop = (
                          group.key === 'overlays'
                          && Boolean(draggedLayerId)
                          && visibleOrderIds.includes(draggedLayerId)
                          && item.draggable
                        );
                        const isDragOverTarget = (
                          canReceiveDrop
                          && dragOverState.groupKey === group.key
                          && dragOverState.targetLayerId === item.orderId
                          && draggedLayerId !== item.orderId
                        );
                        return (
                          <div
                            key={item.id}
                            className={`layer-manager-item ${item.checked ? 'is-visible' : 'is-hidden'} ${(item.disabled || item.loading) ? 'is-disabled' : ''} ${draggedLayerId === item.orderId ? 'is-dragging' : ''} ${isDragOverTarget && dragOverState.position === 'before' ? 'is-drag-over-before' : ''} ${isDragOverTarget && dragOverState.position === 'after' ? 'is-drag-over-after' : ''}`}
                            draggable={Boolean(item.draggable)}
                            onDragStart={item.draggable ? (event) => handleLayerDragStart(event, item.orderId) : undefined}
                            onDragEnd={item.draggable ? handleLayerDragEnd : undefined}
                            onDragOver={canReceiveDrop ? (event) => handleLayerDragOver(event, group.key, item.orderId) : undefined}
                            onDrop={canReceiveDrop ? (event) => handleLayerDrop(event, group.key, visibleOrderIds, item.orderId) : undefined}
                          >
                            <div className="layer-manager-item-main">
                              <div className="layer-manager-item-checkbox-wrap">
                                <input
                                  type="checkbox"
                                  className={`layer-manager-checkbox ${item.checkboxState ? `is-${item.checkboxState}` : ''}`}
                                  checked={item.checked}
                                  onChange={item.onToggle}
                                  disabled={item.disabled || item.loading}
                                />
                              </div>
                              <div className="layer-manager-item-content">
                                {item.onSelect ? (
                                  <button
                                    type="button"
                                    className="layer-manager-item-trigger"
                                    onClick={item.onSelect}
                                    disabled={item.disabled || item.loading}
                                  >
                                    <LayerManagerItemCopy item={item} />
                                  </button>
                                ) : (
                                  <LayerManagerItemCopy item={item} />
                                )}
                              </div>
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
                        );
                      })}
                  </div>
                </section>
              ))}
            </div>
            <LocationScopePicker embedded />
          </div>
        </section>

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


