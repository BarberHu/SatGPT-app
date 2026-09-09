/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { Profiler, startTransition, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useCoAgent, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import LayerManager from './LayerManager';
import {
  getFloodImages,
  getFloodImpact,
  getFloodLayerCatalog,
  renderRecommendedLayer,
} from '../services/agentApi';
import useAgentRasterDownload from '../hooks/useAgentRasterDownload';
import useAgentRasterLayerRequest from '../hooks/useAgentRasterLayerRequest';
import {
  buildAoiBoundsSignature as buildBoundsSignature,
  buildAoiFromAgentState,
  buildAoiSignature,
  buildAskMapRequestParams,
  resolveAgentAnalysisAoi,
} from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import {
  buildCatalogLegendModel,
  getCatalogMapLayerId,
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { buildCatalogLayerContextKey } from '../utils/catalogLayerContext';
import { finalizeLatestRequest } from '../utils/latestRequest';
import {
  resolveDefaultCatalogHistoryRange,
  resolveDefaultCatalogPointSelection,
  resolveDefaultCatalogYearRange,
} from '../utils/catalogTimeDefaults';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import SOURCE_REFERENCES from '../config/agentLayerSourceReferences';
import { FLOOD_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';
import { DEFAULT_FLOOD_AGENT_STATE } from '../config/floodAgentState';
import {
  createReactProfilerHandler,
  startAgentDiagnosticSpan,
  updateAgentDiagnosticsContext,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
import 'rc-slider/assets/index.css';
import './AgentPanel.css';

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
  flood_detection: {
    type: 'solid',
    label: 'Flood extent',
    color: '#ff0000',
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
};

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

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
  const imageryAbortControllerRef = useRef(null);
  const impactAbortControllerRef = useRef(null);
  const pendingRecommendedLayerRequestsRef = useRef(new Set());
  const agentRecommendedLayerDataRef = useRef(agentRecommendedLayerData);
  const previousSelectedAoiSignatureRef = useRef('no-aoi');

  useEffect(() => () => {
    imageryAbortControllerRef.current?.abort();
    imageryAbortControllerRef.current = null;
    impactAbortControllerRef.current?.abort();
    impactAbortControllerRef.current = null;
  }, []);
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
      ...DEFAULT_FLOOD_AGENT_STATE,
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
      ...DEFAULT_FLOOD_AGENT_STATE,
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

    const rasterItems = FLOOD_RASTER_LAYER_CONFIG.map((layer, index) => {
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

    const previousController = imageryAbortControllerRef.current;
    const requestController = new AbortController();
    imageryRequestKeyRef.current = requestKey;
    imageryAbortControllerRef.current = requestController;
    previousController?.abort();
    impactAbortControllerRef.current?.abort();
    impactAbortControllerRef.current = null;
    impactRequestKeyRef.current = null;
    setAgentImpactLoading(false);
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
    let releaseRequestKeyForRetry = false;

    try {
      const result = await getFloodImages({
        pre_date: agentState.pre_date,
        peek_date: agentState.peek_date,
        after_date: agentState.after_date,
        longitude: agentState.coordinates?.[0] || 0,
        latitude: agentState.coordinates?.[1] || 0,
        bounds: aoi?.bounds || agentState.bounds || null,
        geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      }, { signal: requestController.signal });

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
      if (error?.isCanceled) {
        finishImagerySpan({ status: 'cancelled' });
        return;
      }
      if (imageryRequestKeyRef.current !== requestKey) {
        return;
      }
      console.error('Failed to fetch imagery:', error);
      releaseRequestKeyForRetry = true;
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
      if (imageryAbortControllerRef.current === requestController) {
        imageryAbortControllerRef.current = null;
      }
      finalizeLatestRequest({
        requestKeyRef: imageryRequestKeyRef,
        requestKey,
        setLoading: setAgentImageryLoading,
        releaseForRetry: releaseRequestKeyForRetry,
      });
    }
  }, [setAgentImagery, setAgentImageryLoading, setAgentImpactData, setAgentImpactLoading, setAgentTileError, setWarning]);

  useEffect(() => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate || !currentAfterDate) {
      imageryAbortControllerRef.current?.abort();
      imageryAbortControllerRef.current = null;
      impactAbortControllerRef.current?.abort();
      impactAbortControllerRef.current = null;
      imageryRequestKeyRef.current = null;
      impactRequestKeyRef.current = null;
      setAgentImageryLoading(false);
      setAgentImpactLoading(false);
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
    setAgentImageryLoading,
    setAgentImpactLoading,
  ]);

  // Fetch flood impact assessment data
  const fetchImpactData = useCallback(async () => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate) return;

    const requestKey = [
      currentPreDate || '',
      currentPeekDate || '',
      effectiveAoiSignature,
    ].join('|');

    if (impactRequestKeyRef.current === requestKey) {
      return;
    }

    const previousController = impactAbortControllerRef.current;
    const requestController = new AbortController();
    impactRequestKeyRef.current = requestKey;
    impactAbortControllerRef.current = requestController;
    previousController?.abort();
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
    let releaseRequestKeyForRetry = false;
    try {
      const result = await getFloodImpact({
        pre_date: currentPreDate,
        peek_date: currentPeekDate,
        bounds: effectiveAoi?.bounds || currentBounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentGeojson || null,
      }, { signal: requestController.signal });

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
      if (error?.isCanceled) {
        finishImpactSpan({ status: 'cancelled' });
        return;
      }
      if (impactRequestKeyRef.current !== requestKey) {
        return;
      }
      console.error('Failed to fetch impact data:', error);
      releaseRequestKeyForRetry = true;
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
      if (impactAbortControllerRef.current === requestController) {
        impactAbortControllerRef.current = null;
      }
      finalizeLatestRequest({
        requestKeyRef: impactRequestKeyRef,
        requestKey,
        setLoading: setAgentImpactLoading,
        releaseForRetry: releaseRequestKeyForRetry,
      });
    }
  }, [
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
    const requestController = new AbortController();
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
        }, { signal: requestController.signal });

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
        if (!cancelled && !error?.isCanceled) {
          setWarning(error?.message || 'Failed to render recommended layer.');
        }
        finishLayerSpan({
          status: cancelled || error?.isCanceled ? 'cancelled' : 'error',
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
      requestController.abort();
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
                source: 'agent_state',
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
