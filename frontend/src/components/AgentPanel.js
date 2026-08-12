/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { Profiler, startTransition, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useCoAgent, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import LayerManager from './LayerManager';
import { getFloodImages, getFloodImpact, renderRecommendedLayer } from '../services/agentApi';
import useAgentRasterDownload from '../hooks/useAgentRasterDownload';
import { getAgentRasterLayers } from '../services/api';
import {
  buildAoiBoundsSignature as buildBoundsSignature,
  buildAoiFromAgentState,
  buildAoiSignature,
  buildAskMapRequestParams,
  buildEarthEngineGeometryExpression,
  resolveAgentAnalysisAoi,
} from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import {
  buildCatalogLegendModel,
  getCatalogMapLayerId,
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { buildCatalogLayerContextKey } from '../utils/catalogLayerContext';
import {
  resolveDefaultCatalogHistoryRange,
  resolveDefaultCatalogPointSelection,
  resolveDefaultCatalogYearRange,
} from '../utils/catalogTimeDefaults';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import SOURCE_REFERENCES from '../config/agentLayerSourceReferences';
import {
  createReactProfilerHandler,
  startAgentDiagnosticSpan,
  updateAgentDiagnosticsContext,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
import FLOOD_DEFAULT_CATALOG_LAYERS from '../config/floodDefaultCatalogLayers';
import 'rc-slider/assets/index.css';
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
  recommendation_strategy: null,
  recommendation_source: null,
  confirmation_version: 0,
  search_sources: null,
  gee_code: null,
  is_valid_flood_query: false,
};

const formatCoordinatePart = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(6) : '';
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

const buildRecommendedLayerContextKey = ({
  confirmationVersion,
  preDate,
  peekDate,
  afterDate,
  aoiSignature,
  layerSignature,
  timeOverrideSignature,
}) => [
  confirmationVersion || 0,
  preDate || '',
  peekDate || '',
  afterDate || '',
  aoiSignature || 'no-aoi',
  layerSignature || 'no-layers',
  timeOverrideSignature || 'default-time',
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
const JRC_YEARLY_MIN_YEAR = 1984;
const JRC_YEARLY_MAX_YEAR = 2021;
const DEFAULT_HOTSPOT_YEAR_RANGE = resolveDefaultCatalogHistoryRange({
  minYear: JRC_YEARLY_MIN_YEAR,
  maxYear: JRC_YEARLY_MAX_YEAR,
});
const YEAR_RANGE_MARKS = {
  1984: '1984',
  2000: '2000',
  2010: '2010',
  2021: '2021',
};
const MONTH_OPTIONS = [
  { value: 1, label: 'Jan' },
  { value: 2, label: 'Feb' },
  { value: 3, label: 'Mar' },
  { value: 4, label: 'Apr' },
  { value: 5, label: 'May' },
  { value: 6, label: 'Jun' },
  { value: 7, label: 'Jul' },
  { value: 8, label: 'Aug' },
  { value: 9, label: 'Sep' },
  { value: 10, label: 'Oct' },
  { value: 11, label: 'Nov' },
  { value: 12, label: 'Dec' },
];
const MONTH_SLIDER_MARKS = {
  1: 'Jan',
  4: 'Apr',
  7: 'Jul',
  10: 'Oct',
  12: 'Dec',
};
const YEAR_OPTIONS = Array.from(
  { length: JRC_YEARLY_MAX_YEAR - JRC_YEARLY_MIN_YEAR + 1 },
  (_, index) => JRC_YEARLY_MIN_YEAR + index
);

const getMonthLabel = (month) => (
  MONTH_OPTIONS.find((option) => option.value === Number(month))?.label || String(month)
);

const clampYear = (value, fallback = JRC_YEARLY_MAX_YEAR) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(JRC_YEARLY_MAX_YEAR, Math.max(JRC_YEARLY_MIN_YEAR, Math.trunc(numeric)));
};

const normalizeYearRange = (start, end, fallback = DEFAULT_HOTSPOT_YEAR_RANGE) => {
  const fallbackStart = Array.isArray(fallback) ? fallback[0] : JRC_YEARLY_MIN_YEAR;
  const fallbackEnd = Array.isArray(fallback) ? fallback[1] : JRC_YEARLY_MAX_YEAR;
  const yearStart = clampYear(start, fallbackStart);
  const yearEnd = Math.max(yearStart, clampYear(end, fallbackEnd));
  return [yearStart, yearEnd];
};

const getYearRangeCount = (range = []) => Math.max(1, (Number(range[1]) || 0) - (Number(range[0]) || 0) + 1);

const getMonthFromDate = (value, fallback = 1) => {
  const match = String(value || '').match(/^\d{4}-(\d{2})/);
  const numeric = match ? Number(match[1]) : fallback;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(12, Math.max(1, Math.trunc(numeric)));
};

const formatMonthDate = (year, month) => `${year}-${String(month).padStart(2, '0')}-01`;

const nextMonthDate = (year, month) => {
  const nextMonth = month >= 12 ? 1 : month + 1;
  const nextYear = month >= 12 ? year + 1 : year;
  return formatMonthDate(nextYear, nextMonth);
};

const normalizeDateWindow = (startDate, endDate) => {
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || '').slice(0, 10);
  return {
    start_date: start,
    end_date: end || start,
  };
};

const buildDefaultCatalogDateWindow = (dayCount = 30) => {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(dayCount) || 30) + 1);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
};

const DEFAULT_CATALOG_DATE_WINDOW = buildDefaultCatalogDateWindow();

const isValidDateWindow = (window) => (
  Boolean(window?.start_date && window?.end_date && window.start_date <= window.end_date)
);

const resolveSingleInundationDateWindow = (override = {}, dates = {}) => {
  const [defaultStartYear, defaultEndYear] = resolveDefaultCatalogYearRange({
    startDate: dates.currentPreDate,
    peakDate: dates.currentPeekDate,
    endDate: dates.currentAfterDate,
    minYear: JRC_YEARLY_MIN_YEAR,
    maxYear: JRC_YEARLY_MAX_YEAR,
  });
  const yearStart = clampYear(override.year_start ?? defaultStartYear, defaultStartYear);
  const yearEnd = Math.max(yearStart, clampYear(override.year_end ?? defaultEndYear, defaultEndYear));
  return {
    mode: 'year_range',
    year_start: yearStart,
    year_end: yearEnd,
    start_date: `${yearStart}-01-01`,
    end_date: `${yearEnd}-12-31`,
    valueLabel: `${yearStart}-${yearEnd}`,
  };
};

const getCatalogTimeControlMode = (layer) => {
  if (!layer || layer.execution_profile?.requires_date_range === false) {
    return null;
  }
  if (layer.temporal_type === 'yearly') {
    return 'year';
  }
  if (layer.temporal_type === 'monthly') {
    return 'month';
  }
  return 'date_range';
};

const resolveCatalogLayerDateWindow = (layer, override = {}, dates = {}) => {
  const mode = getCatalogTimeControlMode(layer);
  if (!mode) {
    return { mode: null, start_date: null, end_date: null, valueLabel: 'Static' };
  }

  const eventStart = dates.currentPreDate || dates.currentPeekDate || '';
  const eventEnd = dates.currentAfterDate || dates.currentPeekDate || eventStart;
  const eventPeak = dates.currentPeekDate || eventStart || eventEnd;
  const defaultPointSelection = resolveDefaultCatalogPointSelection({
    peakDate: eventPeak,
    startDate: eventStart,
    endDate: eventEnd,
    minYear: JRC_YEARLY_MIN_YEAR,
    maxYear: JRC_YEARLY_MAX_YEAR,
  });

  if (mode === 'year') {
    const defaultYear = defaultPointSelection.year;
    const year = clampYear(override.year ?? defaultYear, defaultYear);
    return {
      mode,
      year,
      start_date: `${year}-01-01`,
      end_date: `${year + 1}-01-01`,
      valueLabel: String(year),
    };
  }

  if (mode === 'month') {
    const defaultYear = defaultPointSelection.year;
    const defaultMonth = defaultPointSelection.month;
    const year = clampYear(override.year ?? defaultYear, defaultYear);
    const month = getMonthFromDate(`${year}-${String(override.month ?? defaultMonth).padStart(2, '0')}-01`, defaultMonth);
    return {
      mode,
      year,
      month,
      start_date: formatMonthDate(year, month),
      end_date: nextMonthDate(year, month),
      valueLabel: `${year}-${String(month).padStart(2, '0')}`,
    };
  }

  const window = normalizeDateWindow(
    override.start_date || eventStart || eventEnd || DEFAULT_CATALOG_DATE_WINDOW.start_date,
    override.end_date || eventEnd || eventStart || DEFAULT_CATALOG_DATE_WINDOW.end_date
  );
  return {
    mode,
    ...window,
    valueLabel: window.start_date && window.end_date ? `${window.start_date} to ${window.end_date}` : 'Needs dates',
  };
};

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
    type: 'classes',
    label: 'Soil texture classes',
    items: [
      { value: 'Cl', color: '#d5c36b' },
      { value: 'SiCl', color: '#b96947' },
      { value: 'SaCl', color: '#9d3706' },
      { value: 'ClLo', color: '#ae868f' },
      { value: 'SiClLo', color: '#f86714' },
      { value: 'SaClLo', color: '#46d143' },
      { value: 'Lo', color: '#368f20' },
      { value: 'SiLo', color: '#3e5a14' },
      { value: 'SaLo', color: '#ffd557' },
      { value: 'Si', color: '#fff72e' },
      { value: 'LoSa', color: '#ff5a9d' },
      { value: 'Sa', color: '#ff005b' },
    ],
  },
};

const FIELD_LABELS = {
  asset_id: 'Asset ID',
  asset_type: 'Asset type',
  cacheable: 'Cacheable',
  default_selected: 'Default visible',
  location_scope: 'Location scope',
  product_group: 'Product group',
  recommendable: 'Recommendable',
  reducer: 'Reducer',
  requires_aoi: 'Requires AOI',
  requires_date_range: 'Requires dates',
  select_bands: 'Selected bands',
  spatial_scope: 'Spatial scope',
  supports_tile: 'Supports tile',
  temporal_type: 'Temporal type',
};

const AGENT_RASTER_LAYER_CONFIG = [
  {
    key: 'singleInundationEvent',
    orderId: 'agent-raster-singleInundationEvent',
    title: 'Single Inundation Event',
    infoText: 'JRC Global Surface Water yearly history clipped to the selected AOI for a single analysis time window.',
    dataset: SOURCE_REFERENCES.jrcGswYearlyHistory.datasetId,
    method: 'JRC YearlyHistory permanent water and seasonal inundation classes',
    sourceRef: SOURCE_REFERENCES.jrcGswYearlyHistory,
    legend: {
      type: 'classes',
      label: 'Water classification',
      items: [
        { value: 'Permanent water', color: '#00008B' },
        { value: 'Inundated area', color: '#FD0303' },
      ],
    },
  },
  {
    key: 'inundationHotspot',
    orderId: 'agent-raster-inundationHotspot',
    title: 'Inundation Hotspot',
    infoText: 'Long-term inundation frequency from JRC yearly water history, excluding mapped permanent water.',
    dataset: SOURCE_REFERENCES.jrcGswYearlyHistory.datasetId,
    method: 'Flood frequency over configurable historical duration',
    sourceRef: SOURCE_REFERENCES.jrcGswYearlyHistory,
    legend: {
      type: 'palette',
      label: 'Inundation hotspot frequency',
      min: '10%',
      max: '80%',
      palette: ['#ffa9bb', '#ff8f9e', '#ff6171', '#ff3b50', '#ff084a'],
    },
    hasDurationControl: true,
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

const titleCaseKey = (key) => String(key || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const formatInfoValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => formatInfoValue(entry))
      .filter(Boolean)
      .join(', ');
  }

  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entryValue]) => {
        const formatted = formatInfoValue(entryValue);
        return formatted ? `${FIELD_LABELS[key] || titleCaseKey(key)}: ${formatted}` : null;
      })
      .filter(Boolean)
      .join('; ');
  }

  return String(value);
};

const objectRows = (source = {}, keys = []) => keys
  .map((key) => ({
    label: FIELD_LABELS[key] || titleCaseKey(key),
    value: source?.[key],
  }))
  .filter((row) => formatInfoValue(row.value));

const trimEarthEngineTitle = (title) => String(title || '')
  .replace(/\s*\|\s*Earth Engine Data Catalog\s*\|\s*Google for Developers\s*$/i, '')
  .trim();

const mergeCatalogSourceMeta = (layer, descriptor) => ({
  ...(layer?.source_meta || {}),
  ...(descriptor?.source_meta || {}),
});

const formatMapView = (view) => {
  if (!view || typeof view !== 'object') {
    return null;
  }

  const lon = Number(view.lon);
  const lat = Number(view.lat);
  const zoom = Number(view.zoom);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }

  return `lon ${lon.toFixed(3)}, lat ${lat.toFixed(3)}${Number.isFinite(zoom) ? `, zoom ${zoom}` : ''}`;
};

const buildBandMetadataRows = (bandMetadata = [], selectedBands = []) => {
  if (!Array.isArray(bandMetadata) || !bandMetadata.length) {
    return [];
  }

  const selected = new Set((Array.isArray(selectedBands) ? selectedBands : [selectedBands]).filter(Boolean));
  const prioritized = selected.size
    ? [
      ...bandMetadata.filter((band) => selected.has(band?.name)),
      ...bandMetadata.filter((band) => !selected.has(band?.name)),
    ]
    : bandMetadata;

  return prioritized.slice(0, 8).map((band) => {
    const parts = [
      band?.description,
      band?.pixel_size ? `pixel ${band.pixel_size}` : null,
      band?.unit ? `unit ${band.unit}` : null,
      Number.isFinite(Number(band?.min)) && Number.isFinite(Number(band?.max))
        ? `range ${band.min}-${band.max}`
        : null,
    ].filter(Boolean);

    return {
      label: band?.name || 'Band',
      value: parts.join(' | '),
    };
  }).filter((row) => row.label && row.value);
};

const formatRenderMode = (mode) => {
  const normalized = String(mode || '').replace(/_/g, ' ');
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : null;
};

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

function buildFallbackAgentGEECode({
  eventName,
  preDate,
  peekDate,
  afterDate,
  aoi,
}) {
  if (!preDate || !peekDate || !aoi) {
    return '';
  }

  let geometryExpression = '';
  try {
    geometryExpression = buildEarthEngineGeometryExpression(aoi);
  } catch (error) {
    return '';
  }

  return `// Flood Analysis - ${eventName || 'Flood Event'}
// S1 SAR Otsu Change Detection | Generated by FloodAgent

var pre_date = '${preDate}';
var peak_date = '${peekDate}';
var post_date = '${afterDate || ''}';
var days_range = 15;
var AOI = ${geometryExpression};

Map.centerObject(AOI, 10);
Map.addLayer(ee.FeatureCollection(AOI).style({
  color: 'yellow',
  fillColor: '00000000',
  width: 2
}), {}, 'AOI Boundary');

var vv_pre = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterDate(ee.Date(pre_date).advance(-days_range, 'day'), ee.Date(pre_date))
  .filterBounds(AOI)
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .select('VV')
  .median()
  .clip(AOI);

var vv_peak = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterDate(ee.Date(peak_date), ee.Date(peak_date).advance(days_range, 'day'))
  .filterBounds(AOI)
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .select('VV')
  .median()
  .clip(AOI);

Map.addLayer(vv_pre, { min: -25, max: 0 }, 'S1 Pre-flood');
Map.addLayer(vv_peak, { min: -25, max: 0 }, 'S1 Peak-flood');

var change = vv_peak.subtract(vv_pre).rename('change');

var hist = change.reduceRegion({
  reducer: ee.Reducer.histogram(255, 0.2),
  geometry: AOI,
  scale: 30,
  maxPixels: 1e9,
  bestEffort: true
});

var counts = ee.Array(ee.Dictionary(hist.get('change')).get('histogram'));
var means = ee.Array(ee.Dictionary(hist.get('change')).get('bucketMeans'));
var size = means.length().get([0]);
var total = counts.reduce(ee.Reducer.sum(), [0]).get([0]);
var sumAll = counts.multiply(means).reduce(ee.Reducer.sum(), [0]).get([0]);

var threshold = ee.Dictionary(ee.List.sequence(0, size.subtract(1)).iterate(function(i, state) {
  state = ee.Dictionary(state);
  i = ee.Number(i);
  var w0 = state.getNumber('w0').add(counts.get([i]));
  var sum0 = state.getNumber('sum0').add(counts.get([i]).multiply(means.get([i])));
  var w1 = total.subtract(w0);
  var valid = w0.gt(0).and(w1.gt(0));
  var betweenVariance = valid.multiply(w0.multiply(w1).multiply(
    sum0.divide(w0).subtract(sumAll.subtract(sum0).divide(w1)).pow(2)
  ));
  var isMax = betweenVariance.gt(state.getNumber('maxVar'));
  return ee.Dictionary({
    w0: w0,
    sum0: sum0,
    maxVar: isMax.multiply(betweenVariance).add(isMax.not().multiply(state.getNumber('maxVar'))),
    bestT: isMax.multiply(means.get([i])).add(isMax.not().multiply(state.getNumber('bestT')))
  });
}, ee.Dictionary({ w0: 0, sum0: 0, maxVar: 0, bestT: -3 }))).getNumber('bestT');

var floodChange = change.lt(threshold);
var permanentWater = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .gte(95)
  .clip(AOI);
var floodExtent = floodChange.and(permanentWater.not());

Map.addLayer(change, { min: -5, max: 5, palette: ['blue', 'white', 'red'] }, 'SAR Change Index');
Map.addLayer(permanentWater.selfMask(), { palette: ['00008B'] }, 'Permanent Water');
Map.addLayer(floodExtent.selfMask(), { palette: ['ff0000'] }, 'Flood Extent');

var floodAreaKm2 = floodExtent.multiply(ee.Image.pixelArea().divide(1e6)).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: AOI,
  scale: 30,
  maxPixels: 1e9,
  bestEffort: true
});

print('Otsu threshold (dB):', threshold);
print('Flood area (km2):', floodAreaKm2);
print('Post-flood date:', post_date);`;
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
    agentRasterLoading,
    setAgentRasterLoading,
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

  const { state } = useCoAgent({
    name: "flood_agent",
    initialState: defaultAgentState,
  });

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
  const pendingRecommendedLayerRequestsRef = useRef(new Set());
  const pendingAgentRasterRequestKeyRef = useRef({});
  const agentRecommendedLayerDataRef = useRef(agentRecommendedLayerData);
  const selectedAoiSignatureRef = useRef('no-aoi');
  const previousSelectedAoiSignatureRef = useRef('no-aoi');
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
  const rawRecommendationStrategy = rawState?.recommendation_strategy || null;
  const rawRecommendationSource = rawState?.recommendation_source || null;
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
      recommendation_strategy: rawRecommendationStrategy,
      recommendation_source: rawRecommendationSource,
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
      rawRecommendationStrategy,
      rawRecommendationSource,
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
      recommended_layers: stableRecommendedLayers,
      selected_layer_ids: stableSelectedLayerIds,
      recommendation_strategy: rawRecommendationStrategy,
      recommendation_source: rawRecommendationSource,
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
      stableRecommendedLayers,
      stableSelectedLayerIds,
      rawRecommendationStrategy,
      rawRecommendationSource,
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

  useEffect(() => {
    selectedAoiSignatureRef.current = selectedAoiSignature;
  }, [selectedAoiSignature]);

  useEffect(() => {
    const previousSignature = previousSelectedAoiSignatureRef.current;
    previousSelectedAoiSignatureRef.current = selectedAoiSignature;

    if (previousSignature === selectedAoiSignature) {
      return;
    }

    setAgentRasterLayerVisibility((previous) => {
      const next = { ...previous };
      AGENT_RASTER_LAYER_CONFIG.forEach((layer) => {
        next[layer.key] = false;
      });
      return next;
    });
    setAgentLayerLoading((previous) => {
      const next = { ...previous };
      AGENT_RASTER_LAYER_CONFIG.forEach((layer) => {
        next[`raster-${layer.key}`] = false;
      });
      return next;
    });
    setAgentRasterLoading(false);
  }, [
    selectedAoiSignature,
    setAgentLayerLoading,
    setAgentRasterLayerVisibility,
    setAgentRasterLoading,
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

    const requestAoiSignature = selectedAoiSignatureRef.current;
    const requestKey = [
      layerKey,
      requestAoiSignature,
      params.time_start || '',
      params.time_end || '',
      params.year_start || '',
      params.year_end || '',
      params.year_from || '',
      params.year_count || '',
    ].join('|');

    setAgentRasterLoading(true);
    pendingAgentRasterRequestKeyRef.current[layerKey] = requestKey;
    setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: true }));
    try {
      const result = await getAgentRasterLayers(params);

      if (selectedAoiSignatureRef.current !== requestAoiSignature) {
        return;
      }

      mergeLayerData(result, {
        aoiSignature: requestAoiSignature,
        requestKey,
      });
      setWarning('');
    } catch (error) {
      if (selectedAoiSignatureRef.current !== requestAoiSignature) {
        return;
      }

      const message = error?.message || 'Raster layer request failed.';
      setWarning(message);
    } finally {
      if (pendingAgentRasterRequestKeyRef.current[layerKey] === requestKey) {
        delete pendingAgentRasterRequestKeyRef.current[layerKey];
        setAgentRasterLoading(false);
        setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: false }));
      }
    }
  }, [
    buildAgentRasterRequestParams,
    mergeLayerData,
    setAgentLayerLoading,
    setAgentRasterLoading,
    setWarning,
  ]);

  const fallbackGeeCode = useMemo(() => buildFallbackAgentGEECode({
    eventName: currentEvent,
    preDate: currentPreDate,
    peekDate: currentPeekDate,
    afterDate: currentAfterDate,
    aoi: effectiveAoi || agentDerivedAoi,
  }), [
    agentDerivedAoi,
    currentAfterDate,
    currentEvent,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
  ]);
  const downloadableGeeCode = currentGeeCode || fallbackGeeCode;
  const recommendedCatalogLayers = useMemo(
    () => sortCatalogLayers(
      currentRecommendedLayers.filter((layer) => layer.layer_family === 'catalog')
    ),
    [currentRecommendedLayers]
  );
  const controlPanelCatalogLayers = useMemo(() => {
    const byAssetId = new Map();

    FLOOD_DEFAULT_CATALOG_LAYERS.forEach((layer) => {
      byAssetId.set(layer.asset_id || layer.id, layer);
    });

    recommendedCatalogLayers.forEach((layer) => {
      const key = layer.asset_id || layer.id;
      const fallbackLayer = byAssetId.get(key) || {};
      byAssetId.set(key, {
        ...fallbackLayer,
        ...layer,
        source_meta: {
          ...(fallbackLayer.source_meta || {}),
          ...(layer.source_meta || {}),
        },
        selection_profile: {
          ...(fallbackLayer.selection_profile || {}),
          ...(layer.selection_profile || {}),
        },
        render_profile: {
          ...(fallbackLayer.render_profile || {}),
          ...(layer.render_profile || {}),
        },
        execution_profile: {
          ...(fallbackLayer.execution_profile || {}),
          ...(layer.execution_profile || {}),
        },
        ui_profile: {
          ...(fallbackLayer.ui_profile || {}),
          ...(layer.ui_profile || {}),
        },
      });
    });

    return sortCatalogLayers(Array.from(byAssetId.values()));
  }, [recommendedCatalogLayers]);
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

  const layerManagerGroups = useMemo(() => {
    const floodDetectionDescriptor = agentImagery?.flood_detection || null;
    const floodDetectionAvailable = Boolean(floodDetectionDescriptor?.tile_url);
    const floodDetectionLoading = Boolean(agentShowFloodDetection && agentLayerLoading?.['flood-detection']);
    const floodDetectionItem = analysisDisplayEnabled ? [{
      id: 'core-flood-detection',
      orderId: 'agent-flood-detection',
      defaultOrder: 0,
      draggable: true,
      title: 'Flood Detection',
      infoKicker: 'Analysis layer',
      infoMeta: `${currentPreDate || 'pre-date'} -> ${currentPeekDate || 'peak-date'}`,
      infoText: LAYER_META.flood_detection.description,
      infoDetails: [
        { label: 'Source', value: LAYER_META.flood_detection.source },
        { label: 'Auxiliary source', value: SOURCE_REFERENCES.jrcGsw.datasetId },
        { label: 'Method', value: LAYER_META.flood_detection.method },
        { label: 'Resolution', value: LAYER_META.flood_detection.resolution },
        { label: 'Content date', value: `${SOURCE_REFERENCES.sentinel1.contentDate}; ${SOURCE_REFERENCES.jrcGsw.contentDate}` },
        { label: 'License', value: `${SOURCE_REFERENCES.sentinel1.license}; JRC: ${SOURCE_REFERENCES.jrcGsw.license}` },
        { label: 'Status', value: floodDetectionLoading ? 'Loading' : (agentShowFloodDetection ? (floodDetectionAvailable ? 'Visible' : 'Pending') : (floodDetectionAvailable ? 'Ready' : 'Pending')) },
      ],
      infoSections: [
        {
          title: 'Function',
          text: 'Highlights newly inundated pixels by comparing pre-flood and peak SAR observations.',
        },
        {
          title: 'Overview',
          text: 'SatGPT computes this as a derived analysis layer, not as an off-the-shelf flood product. Sentinel-1 GRD provides cloud-resistant SAR backscatter before and during the flood window; JRC Global Surface Water helps mask or contextualize permanent water.',
        },
        {
          title: 'Inputs',
          rows: [
            { label: 'Pre-flood date', value: currentPreDate },
            { label: 'Peak date', value: currentPeekDate },
            { label: 'Auxiliary', value: LAYER_META.flood_detection.auxiliary },
            { label: 'SAR catalog', value: SOURCE_REFERENCES.sentinel1.datasetId },
            { label: 'Water catalog', value: SOURCE_REFERENCES.jrcGsw.datasetId },
          ],
        },
        {
          title: 'Citation',
          text: `${SOURCE_REFERENCES.sentinel1.citation} ${SOURCE_REFERENCES.jrcGsw.citation}`,
        },
      ],
      infoWarnings: ['Threshold-based flood detection is sensitive to date choice, AOI quality, permanent water masking, and SAR noise.'],
      infoLinks: [
        { label: 'Sentinel-1 catalog', href: SOURCE_REFERENCES.sentinel1.officialUrl },
        { label: 'JRC water catalog', href: SOURCE_REFERENCES.jrcGsw.officialUrl },
      ],
      legend: CORE_LAYER_LEGENDS.flood_detection,
      checked: Boolean(agentShowFloodDetection && floodDetectionAvailable),
      disabled: !floodDetectionAvailable,
      loading: floodDetectionLoading,
      loadProgress: agentLayerProgress?.['flood-detection'],
      checkboxState: floodDetectionLoading ? 'loading' : (floodDetectionAvailable ? 'ready' : 'idle'),
      status: floodDetectionLoading ? 'Loading' : (agentShowFloodDetection ? (floodDetectionAvailable ? 'Visible' : 'Pending') : (floodDetectionAvailable ? 'Ready' : 'Pending')),
      tone: floodDetectionLoading ? 'loading' : (agentShowFloodDetection ? (floodDetectionAvailable ? 'ready' : 'pending') : (floodDetectionAvailable ? 'off' : 'pending')),
      onToggle: (event) => {
        if (!floodDetectionAvailable) {
          return;
        }

        const nextVisible = Boolean(event?.target?.checked);
        flushSync(() => {
          setAgentShowFloodDetection(nextVisible);
        });

        if (!nextVisible) {
          removeMapLayerFromMap('agent-flood-detection');
          window.requestAnimationFrame(() => removeMapLayerFromMap('agent-flood-detection'));
        }
      },
    }] : [];

    const rasterItems = AGENT_RASTER_LAYER_CONFIG.map((layer, index) => {
      const descriptor = layerData?.[layer.key] || null;
      const visible = Boolean(agentRasterLayerVisibility?.[layer.key]);
      const hasScope = Boolean(activeAnalysisAoi);
      const requestParams = buildAgentRasterRequestParams(layer.key);
      const hasTile = Boolean(
        descriptor?.tileUrl
        && descriptor?.aoiSignature
        && descriptor.aoiSignature === selectedAoiSignature
      );
      const loading = Boolean(
        hasScope
        && (
          agentLayerLoading?.[`raster-${layer.key}`]
          || (visible && agentRasterLoading && !hasTile)
        )
      );
      const downloadState = rasterDownloadState[layer.key] || null;
      const isDownloading = downloadState?.status === 'preparing';
      const hotspotRange = layer.key === 'inundationHotspot'
        ? normalizeYearRange(
          requestParams?.year_start ?? requestParams?.year_from ?? hotspotYearRange[0],
          requestParams?.year_end ?? (
            requestParams?.year_count
              ? Number(requestParams?.year_from ?? hotspotYearRange[0]) + Number(requestParams.year_count) - 1
              : hotspotYearRange[1]
          ),
          hotspotYearRange
        )
        : null;
      const hotspotYearCount = hotspotRange ? getYearRangeCount(hotspotRange) : null;
      const singleEventWindow = layer.key === 'singleInundationEvent'
        ? resolveSingleInundationDateWindow(
          singleInundationTimeWindow,
          { currentPreDate, currentPeekDate, currentAfterDate }
        )
        : null;

      return {
        id: `raster-${layer.key}`,
        orderId: layer.orderId,
        defaultOrder: 10 + index,
        draggable: true,
        title: layer.title,
        infoKicker: 'Context raster',
        infoMeta: layer.sourceRef.datasetId,
        infoText: layer.infoText,
        infoDetails: [
          { label: 'Source', value: layer.sourceRef.producer },
          { label: 'Dataset ID', value: layer.sourceRef.datasetId },
          { label: 'Method', value: layer.method },
          { label: 'Resolution', value: layer.sourceRef.resolution },
          { label: 'Content date', value: layer.sourceRef.contentDate },
          { label: 'License', value: layer.sourceRef.license },
          { label: 'Scope', value: activeAnalysisAoi?.label || 'No active scope' },
          { label: 'Date window', value: layer.key === 'singleInundationEvent' ? `${requestParams?.time_start || '2010-01-01'} to ${requestParams?.time_end || '2024-12-31'}` : null },
          { label: 'Hotspot period', value: hotspotRange ? `${hotspotRange[0]}-${hotspotRange[1]} (${hotspotYearCount} years)` : null },
          { label: 'Status', value: !hasScope ? 'Unavailable' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Pending'))) },
        ],
        infoSections: [
          {
            title: 'Function',
            text: layer.sourceRef.overview,
          },
          {
            title: 'Source facts',
            rows: [
              { label: 'Producer', value: layer.sourceRef.producer },
              { label: 'Dataset ID', value: layer.sourceRef.datasetId },
              { label: 'Content date', value: layer.sourceRef.contentDate },
              { label: 'License', value: layer.sourceRef.license },
            ],
          },
          {
            title: 'Use in workflow',
            rows: [
              { label: 'Requires scope', value: true },
              { label: 'Active AOI', value: activeAnalysisAoi?.label },
              { label: 'Layer role', value: layer.key === 'singleInundationEvent'
                ? 'Historical single-window inundation evidence'
                : layer.key === 'inundationHotspot'
                  ? 'Long-term inundation hotspot context'
                  : 'Context for interpreting flood exposure and environment' },
              { label: 'Duration', value: hotspotYearCount ? `${hotspotYearCount} years` : null },
            ],
          },
          {
            title: 'Citation',
            text: layer.sourceRef.citation,
          },
        ],
        infoWarnings: [layer.sourceRef.cautions],
        infoLinks: [
          { label: 'Official catalog', href: layer.sourceRef.officialUrl },
          { label: 'DOI', href: layer.sourceRef.doi },
        ],
        infoActions: [
          {
            key: `download-${layer.key}`,
            label: isDownloading ? 'Preparing GeoTIFF...' : 'Download AOI GeoTIFF',
            onClick: () => handleAgentRasterDownload({ layerKey: layer.key, title: layer.title, requestParams }),
            disabled: isDownloading || !(hasScope && hasTile),
            status: downloadState?.status,
            message: downloadState?.message,
            title: isDownloading
              ? 'Preparing the clipped raster file'
              : hasScope && hasTile
                ? 'Download the clipped raster for the current AOI'
              : 'Available after this raster layer is loaded for an AOI',
          },
        ],
        legend: layer.legend,
        sliderControl: layer.key === 'inundationHotspot' && hotspotRange ? {
          range: true,
          label: 'Hotspot period',
          value: hotspotRange,
          valueLabel: `${hotspotRange[0]}-${hotspotRange[1]} (${hotspotYearCount} years)`,
          min: JRC_YEARLY_MIN_YEAR,
          max: JRC_YEARLY_MAX_YEAR,
          step: 1,
          marks: YEAR_RANGE_MARKS,
          pushable: 1,
          disabled: !hasScope || loading,
          helpText: 'Frequency is computed across the selected inclusive year range.',
          onChange: (nextRange) => {
            if (Array.isArray(nextRange)) {
              setHotspotYearRange(normalizeYearRange(nextRange[0], nextRange[1], hotspotRange));
            }
          },
          onCommit: (nextRange) => {
            if (!Array.isArray(nextRange)) {
              return;
            }
            const nextHotspotRange = normalizeYearRange(nextRange[0], nextRange[1], hotspotRange);
            setHotspotYearRange(nextHotspotRange);
            if (agentRasterLayerVisibility?.inundationHotspot) {
              fetchAgentRasterLayer('inundationHotspot', {
                year_start: nextHotspotRange[0],
                year_end: nextHotspotRange[1],
              });
            }
          },
        } : singleEventWindow ? {
          range: true,
          label: 'Year range',
          value: [singleEventWindow.year_start, singleEventWindow.year_end],
          valueLabel: singleEventWindow.valueLabel,
          min: JRC_YEARLY_MIN_YEAR,
          max: JRC_YEARLY_MAX_YEAR,
          step: 1,
          marks: YEAR_RANGE_MARKS,
          pushable: 1,
          disabled: !hasScope || loading,
          helpText: 'JRC yearly classes are annual, so the slider uses whole years.',
          onChange: (nextRange) => {
            if (!Array.isArray(nextRange)) {
              return;
            }
            const [yearStart, yearEnd] = normalizeYearRange(nextRange[0], nextRange[1], [
              singleEventWindow.year_start,
              singleEventWindow.year_end,
            ]);
            setSingleInundationTimeWindow({
              year_start: yearStart,
              year_end: yearEnd,
            });
          },
          onCommit: (nextRange) => {
            if (!Array.isArray(nextRange)) {
              return;
            }
            const [yearStart, yearEnd] = normalizeYearRange(nextRange[0], nextRange[1], [
              singleEventWindow.year_start,
              singleEventWindow.year_end,
            ]);
            const nextWindow = resolveSingleInundationDateWindow(
              { year_start: yearStart, year_end: yearEnd },
              { currentPreDate, currentPeekDate, currentAfterDate }
            );
            setSingleInundationTimeWindow({ year_start: yearStart, year_end: yearEnd });
            if (agentRasterLayerVisibility?.singleInundationEvent) {
              fetchAgentRasterLayer('singleInundationEvent', {
                time_start: nextWindow.start_date,
                time_end: nextWindow.end_date,
              });
            }
          },
        } : null,
        checked: visible,
        disabled: !hasScope,
        loading,
        loadProgress: agentLayerProgress?.[`raster-${layer.key}`],
        checkboxState: !hasScope ? 'idle' : (loading ? 'loading' : (hasTile ? 'ready' : 'idle')),
        status: !hasScope ? 'Unavailable' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Pending'))),
        tone: !hasScope ? 'idle' : (loading ? 'loading' : (visible ? (hasTile ? 'ready' : 'pending') : (hasTile ? 'off' : 'pending'))),
        onToggle: (event) => {
          if (!hasScope) {
            return;
          }

          const nextVisible = Boolean(event?.target?.checked);
          flushSync(() => {
            setAgentRasterLayerVisibility((previous) => ({
              ...previous,
              [layer.key]: nextVisible,
            }));
          });

          if (!nextVisible) {
            removeMapLayerFromMap(layer.orderId);
            window.requestAnimationFrame(() => removeMapLayerFromMap(layer.orderId));
          } else if (!hasTile) {
            fetchAgentRasterLayer(layer.key);
          }
        },
      };
    });

    const recommendedItems = controlPanelCatalogLayers.map((layer, index) => {
      const descriptor = agentRecommendedLayerData?.[layer.id] || null;
      const sourceMeta = mergeCatalogSourceMeta(layer, descriptor);
      const sourceTitle = trimEarthEngineTitle(sourceMeta.title) || layer.title;
      const sourceSummary = sourceMeta.summary || layer.summary;
      const selectedBands = layer.render_profile?.bands || sourceMeta?.legend_spec?.bands;
      const bandRows = buildBandMetadataRows(sourceMeta.band_metadata, selectedBands);
      const visible = Boolean(agentRecommendedLayerVisibility?.[layer.id]);
      const requiresDateRange = layer.execution_profile?.requires_date_range !== false;
      const hasCatalogScope = Boolean(catalogRenderAoi);
      const catalogDateWindow = getCatalogLayerDateWindow(layer);
      const hasRequiredDates = !requiresDateRange || isValidDateWindow(catalogDateWindow);
      const renderable = hasCatalogScope && hasRequiredDates;
      const loading = Boolean(renderable && visible && agentLayerLoading?.[layer.id]);
      const layerContextKey = getRecommendedLayerContextKey(layer);
      const hasTile = Boolean(descriptor?.tile_url && descriptor?.context_key === layerContextKey);
      const orderId = getCatalogMapLayerId(layer.id);
      const yearSliderControl = catalogDateWindow.mode === 'year' ? {
        range: false,
        selectionMode: 'point',
        label: 'Year',
        value: catalogDateWindow.year,
        valueLabel: catalogDateWindow.valueLabel,
        min: JRC_YEARLY_MIN_YEAR,
        max: JRC_YEARLY_MAX_YEAR,
        step: 1,
        marks: YEAR_RANGE_MARKS,
        disabled: !hasCatalogScope,
        helpText: 'Annual products use the selected calendar year.',
        onChange: (nextYear) => {
          setCatalogLayerTimeOverrides((previous) => ({
            ...(previous || {}),
            [layer.id]: {
              ...((previous || {})[layer.id] || {}),
              year: clampYear(nextYear, catalogDateWindow.year),
            },
          }));
        },
      } : null;
      const monthSliderControl = catalogDateWindow.mode === 'month' ? {
        range: false,
        selectionMode: 'point',
        label: 'Month',
        value: catalogDateWindow.month,
        valueLabel: `${catalogDateWindow.year} ${getMonthLabel(catalogDateWindow.month)}`,
        min: 1,
        max: 12,
        step: 1,
        marks: MONTH_SLIDER_MARKS,
        dots: true,
        disabled: !hasCatalogScope,
        helpText: 'Monthly products use the selected year and month.',
        fields: [
          {
            key: 'year',
            label: 'Year',
            type: 'select',
            value: catalogDateWindow.year,
            options: YEAR_OPTIONS.map((year) => ({ value: year, label: String(year) })),
          },
        ],
        onFieldChange: (fieldKey, nextValue) => {
          setCatalogLayerTimeOverrides((previous) => {
            const current = previous?.[layer.id] || {};
            return {
              ...(previous || {}),
              [layer.id]: {
                ...current,
                year: fieldKey === 'year' ? clampYear(nextValue, catalogDateWindow.year) : catalogDateWindow.year,
                month: current.month ?? catalogDateWindow.month,
              },
            };
          });
        },
        onChange: (nextMonth) => {
          setCatalogLayerTimeOverrides((previous) => {
            const current = previous?.[layer.id] || {};
            return {
              ...(previous || {}),
              [layer.id]: {
                ...current,
                year: current.year ?? catalogDateWindow.year,
                month: getMonthFromDate(
                  `${catalogDateWindow.year}-${String(nextMonth).padStart(2, '0')}-01`,
                  catalogDateWindow.month
                ),
              },
            };
          });
        },
      } : null;
      const dateRangeControl = catalogDateWindow.mode === 'date_range' ? {
        label: 'Event window',
        valueLabel: catalogDateWindow.valueLabel,
        mode: 'date_range',
        disabled: false,
        fields: [
          {
            key: 'start_date',
            label: 'Start',
            type: 'date',
            value: catalogDateWindow.start_date,
            max: catalogDateWindow.end_date,
          },
          {
            key: 'end_date',
            label: 'End',
            type: 'date',
            value: catalogDateWindow.end_date,
            min: catalogDateWindow.start_date,
          },
        ],
        onChange: (fieldKey, nextValue) => {
          setCatalogLayerTimeOverrides((previous) => {
            let nextStart = fieldKey === 'start_date' ? nextValue : catalogDateWindow.start_date;
            let nextEnd = fieldKey === 'end_date' ? nextValue : catalogDateWindow.end_date;
            if (nextStart && nextEnd && nextStart > nextEnd) {
              if (fieldKey === 'start_date') {
                nextEnd = nextStart;
              } else {
                nextStart = nextEnd;
              }
            }
            return {
              ...(previous || {}),
              [layer.id]: {
                ...((previous || {})[layer.id] || {}),
                start_date: nextStart,
                end_date: nextEnd,
              },
            };
          });
        },
      } : null;
      const dateWindowDetailText = catalogDateWindow.mode === 'date_range'
        ? (hasRequiredDates
          ? `Event window: ${catalogDateWindow.valueLabel}`
          : 'Event window required from the flood event')
        : null;
      const statusLabel = !hasCatalogScope
        ? 'Unavailable: select an AOI first'
        : (!hasRequiredDates
          ? 'Needs time window'
          : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : 'Hidden')));
      return {
        id: `recommended-${layer.id}`,
        orderId,
        defaultOrder: 100 + index,
        draggable: true,
        title: layer.title,
        infoKicker: layer.ui_profile?.group_label || 'Recommended dataset',
        infoMeta: sourceMeta.asset_id || layer.asset_id,
        infoText: sourceSummary || layer.ui_profile?.group_label || 'Recommended catalog layer',
        detailText: dateWindowDetailText,
        infoDetails: [
          { label: 'Group', value: layer.ui_profile?.group_label || layer.product_group },
          { label: 'Source', value: sourceTitle },
          { label: 'Asset ID', value: sourceMeta.asset_id || layer.asset_id },
          { label: 'Asset type', value: sourceMeta.asset_type || layer.asset_type },
          { label: 'Temporal', value: sourceMeta.temporal_type || layer.temporal_type },
          { label: 'Time window', value: catalogDateWindow.valueLabel },
          { label: 'Coverage', value: sourceMeta.spatial_scope || layer.spatial_scope },
          { label: 'Status', value: statusLabel },
        ],
        infoSections: [
          {
            title: 'Overview',
            text: sourceSummary,
          },
          {
            title: 'GEE catalog source',
            rows: [
              { label: 'Source list', value: sourceMeta.catalog_source_label },
              { label: 'Asset type', value: sourceMeta.asset_type || layer.asset_type },
              { label: 'Temporal type', value: sourceMeta.temporal_type || layer.temporal_type },
              { label: 'Spatial scope', value: sourceMeta.spatial_scope || layer.spatial_scope },
              { label: 'Themes', value: sourceMeta.themes || layer.themes },
              { label: 'Constraints', value: sourceMeta.constraints },
              { label: 'Default map view', value: formatMapView(sourceMeta.default_map_view) },
              { label: 'Official recipe', value: sourceMeta.has_official_recipe ?? layer.has_official_recipe },
              { label: 'Example code', value: sourceMeta.has_official_example_code ?? layer.has_official_example_code },
            ],
          },
          bandRows.length ? {
            title: 'Band metadata',
            rows: bandRows,
          } : null,
          {
            title: 'Selection',
            rows: [
              ...objectRows(layer.selection_profile, ['priority', 'default_selected', 'location_scope', 'recommendable']),
              { label: 'Score', value: layer.score },
            ],
          },
          {
            title: 'Rendering',
            rows: [
              { label: 'Mode', value: formatRenderMode(layer.render_profile?.mode) },
              { label: 'Bands', value: layer.render_profile?.bands },
              { label: 'Opacity', value: layer.ui_profile?.default_opacity },
              { label: 'Palette', value: layer.render_profile?.palette },
            ],
          },
          {
            title: 'Execution',
            rows: objectRows(layer.execution_profile, ['requires_aoi', 'requires_date_range', 'select_bands', 'reducer', 'supports_tile', 'cacheable']),
          },
        ],
        infoWarnings: [
          visible && !hasTile ? 'Layer is selected but tile rendering has not completed yet.' : null,
          !hasCatalogScope ? 'Select an AOI before rendering this dataset.' : null,
          hasCatalogScope && !hasRequiredDates ? 'This dataset needs a valid time window before rendering.' : null,
        ],
        infoLinks: [
          { label: 'Official dataset page', href: sourceMeta.official_url || layer.official_url || descriptor?.official_url },
          { label: 'GEE water catalog source', href: sourceMeta.catalog_source_url },
        ].filter((link) => link.href),
        legend: buildCatalogLegendModel(descriptor || layer, layer.title),
        sliderControl: yearSliderControl || monthSliderControl,
        timeWindowControl: dateRangeControl,
        checked: visible,
        disabled: !renderable,
        loading,
        loadProgress: agentLayerProgress?.[layer.id],
        checkboxState: !renderable ? 'idle' : (loading ? 'loading' : (hasTile ? 'ready' : 'idle')),
        status: statusLabel,
        tone: !renderable
          ? 'idle'
          : (loading ? 'loading' : (visible ? (hasTile ? 'ready' : 'pending') : 'off')),
        badge: layer.ui_profile?.badge_label || null,
        onToggle: (event) => {
          if (!hasCatalogScope) {
            setWarning('Please select an AOI before loading this catalog layer.');
            return;
          }
          if (!hasRequiredDates) {
            setWarning('This catalog layer needs a valid time window before it can be loaded.');
            return;
          }

          const nextVisible = Boolean(event?.target?.checked);
          flushSync(() => {
            setAgentRecommendedLayerVisibility((previous) => ({
              ...previous,
              [layer.id]: nextVisible,
            }));
          });

          if (!nextVisible) {
            removeMapLayerFromMap(orderId);
            window.requestAnimationFrame(() => removeMapLayerFromMap(orderId));
          }
        },
      };
    });

    const overlayItems = [
      ...floodDetectionItem,
      ...rasterItems,
      ...recommendedItems,
    ];

    const groups = [];

    if (overlayItems.length > 0) {
      groups.push({
        key: 'overlays',
        label: 'Raster Layers',
        items: overlayItems,
      });
    }

    return groups;
  }, [
    agentImagery,
    agentLayerLoading,
    agentLayerProgress,
    agentRasterLayerVisibility,
    agentRasterLoading,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    analysisDisplayEnabled,
    catalogRenderAoi,
    controlPanelCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    getCatalogLayerDateWindow,
    getRecommendedLayerContextKey,
    layerData,
    rasterDownloadState,
    agentShowFloodDetection,
    buildAgentRasterRequestParams,
    handleAgentRasterDownload,
    fetchAgentRasterLayer,
    hotspotYearRange,
    activeAnalysisAoi,
    selectedAoiSignature,
    singleInundationTimeWindow,
    removeMapLayerFromMap,
    setAgentRasterLayerVisibility,
    setAgentRecommendedLayerVisibility,
    setAgentShowFloodDetection,
    setWarning,
  ]);
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

  useEffect(() => {
    const catalogLayersById = new Map(
      controlPanelCatalogLayers.map((layer) => [layer.id, layer])
    );

    setAgentRecommendedLayerData((previous) => {
      let changed = false;
      const next = {};

      Object.entries(previous || {}).forEach(([layerId, descriptor]) => {
        const layer = catalogLayersById.get(layerId);
        if (layer && descriptor?.context_key === getRecommendedLayerContextKey(layer)) {
          next[layerId] = descriptor;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [controlPanelCatalogLayers, getRecommendedLayerContextKey, setAgentRecommendedLayerData]);

  useEffect(() => {
    pendingRecommendedLayerRequestsRef.current.clear();
  }, [recommendedLayerBaseContextKey]);

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
    const visibleCatalogLayers = controlPanelCatalogLayers.filter((layer) => (
      agentRecommendedLayerVisibility[layer.id] && canRenderCatalogLayer(layer)
    ));
    if (!catalogRenderAoi || !visibleCatalogLayers.length) {
      return;
    }

    let cancelled = false;
    const pendingRecommendedLayerRequests = pendingRecommendedLayerRequestsRef.current;
    const layerRequestsToRender = visibleCatalogLayers.map((layer) => {
      const contextKey = getRecommendedLayerContextKey(layer);
      return {
        layer,
        contextKey,
        requestToken: `${contextKey}:${layer.id}`,
      };
    }).filter(({ layer, contextKey, requestToken }) => {
      const cached = agentRecommendedLayerDataRef.current?.[layer.id];
      return !(
        (cached?.tile_url && cached?.context_key === contextKey)
        || pendingRecommendedLayerRequests.has(requestToken)
      );
    });

    if (!layerRequestsToRender.length) {
      return undefined;
    }

    const processLayer = async ({ layer, contextKey, requestToken }) => {
      const finishLayerSpan = startAgentDiagnosticSpan('layer', 'render_recommended_layer', {
        requestToken,
        layerId: layer.id,
        layerTitle: layer.title || layer.id,
      });

      pendingRecommendedLayerRequests.add(requestToken);
      setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: true }));

      try {
        const layerDateWindow = getCatalogLayerDateWindow(layer);
        const result = await renderRecommendedLayer({
          layer_id: layer.id,
          recommended_layers: controlPanelCatalogLayers,
          confirmed_aoi: catalogRenderAoi,
          pre_date: layerDateWindow.start_date || currentPreDate,
          peek_date: currentPeekDate || layerDateWindow.start_date,
          after_date: layerDateWindow.end_date || currentAfterDate,
        });

        if (cancelled || !result?.success) {
          finishLayerSpan({ status: cancelled ? 'cancelled' : 'unsuccessful' });
          return;
        }

        setAgentRecommendedLayerData((previous) => ({
          ...previous,
          [layer.id]: {
            ...result.data,
            context_key: contextKey,
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
      for (let index = 0; index < layerRequestsToRender.length && !cancelled; index += RECOMMENDED_LAYER_MAX_CONCURRENCY) {
        const batch = layerRequestsToRender.slice(index, index + RECOMMENDED_LAYER_MAX_CONCURRENCY);
        await Promise.allSettled(batch.map((request) => processLayer(request)));
      }
    };

    runRenderQueue();
    
    return () => {
      cancelled = true;
      layerRequestsToRender.forEach(({ requestToken }) => {
        pendingRecommendedLayerRequests.delete(requestToken);
      });
      setAgentLayerLoading((previous) => {
        let changed = false;
        const next = { ...previous };
        layerRequestsToRender.forEach(({ layer }) => {
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
    canRenderCatalogLayer,
    catalogRenderAoi,
    controlPanelCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    getCatalogLayerDateWindow,
    getRecommendedLayerContextKey,
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
            <LayerManager
              groups={layerManagerGroups}
              layerOrder={agentLayerOrder}
              setLayerOrder={setAgentLayerOrder}
            />
          </div>
        </section>

        {/* GEE Code Download - bottom of panel, same style as Ask mode */}
        <div className="download-btn-div">
          <button
            type="button"
            className={`submit btn download ${!downloadableGeeCode ? 'disabled' : ''}`}
            onClick={() => {
              if (!downloadableGeeCode) {
                return;
              }
              trackUxEvent('export_gee_code', {
                event: currentEvent || null,
                mode: 'agent',
                source: currentGeeCode ? 'agent_state' : 'frontend_fallback',
              });
              downloadGEECode(downloadableGeeCode, currentEvent);
            }}
            disabled={!downloadableGeeCode}
            style={{
              cursor: downloadableGeeCode ? 'pointer' : 'not-allowed',
              opacity: downloadableGeeCode ? 1 : 0.5,
              pointerEvents: downloadableGeeCode ? 'auto' : 'none',
            }}
            title={downloadableGeeCode ? 'Download Google Earth Engine JavaScript' : 'GEE code is available after event dates and AOI are resolved'}
          >
            DOWNLOAD GEE CODE
          </button>
        </div>
      </div>
    </Profiler>
  );
}

export default AgentPanel;


