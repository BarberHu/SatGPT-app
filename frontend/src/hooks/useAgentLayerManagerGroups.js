import { useMemo } from 'react';
import { flushSync } from 'react-dom';
import { buildCatalogLegendModel, getCatalogMapLayerId } from '../utils/catalogLayers';
import {
  resolveDefaultCatalogHistoryRange,
  resolveDefaultCatalogPointSelection,
  resolveDefaultCatalogYearRange,
} from '../utils/catalogTimeDefaults';
import SOURCE_REFERENCES from '../config/agentLayerSourceReferences';
import { FLOOD_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';

const JRC_YEARLY_MIN_YEAR = 1984;
const JRC_YEARLY_MAX_YEAR = 2021;
export const DEFAULT_HOTSPOT_YEAR_RANGE = resolveDefaultCatalogHistoryRange({
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

export const normalizeYearRange = (start, end, fallback = DEFAULT_HOTSPOT_YEAR_RANGE) => {
  const fallbackStart = Array.isArray(fallback) ? fallback[0] : JRC_YEARLY_MIN_YEAR;
  const fallbackEnd = Array.isArray(fallback) ? fallback[1] : JRC_YEARLY_MAX_YEAR;
  const yearStart = clampYear(start, fallbackStart);
  const yearEnd = Math.max(yearStart, clampYear(end, fallbackEnd));
  return [yearStart, yearEnd];
};

export const getYearRangeCount = (range = []) => Math.max(1, (Number(range[1]) || 0) - (Number(range[0]) || 0) + 1);

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

export const isValidDateWindow = (window) => (
  Boolean(window?.start_date && window?.end_date && window.start_date <= window.end_date)
);

export const resolveSingleInundationDateWindow = (override = {}, dates = {}) => {
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
  if (layer.execution_profile?.time_selection?.mode === 'calendar_month_property') {
    return 'calendar_month';
  }
  if (layer.temporal_type === 'yearly') {
    return 'year';
  }
  if (layer.temporal_type === 'monthly') {
    return 'month';
  }
  return 'date_range';
};

export const resolveCatalogLayerDateWindow = (layer, override = {}, dates = {}) => {
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

  if (mode === 'calendar_month') {
    const defaultMonth = defaultPointSelection.month;
    const month = getMonthFromDate(
      `2000-${String(override.month ?? defaultMonth).padStart(2, '0')}-01`,
      defaultMonth
    );
    const startYear = Number(layer.execution_profile?.time_selection?.start_year) || JRC_YEARLY_MIN_YEAR;
    const endYear = Number(layer.execution_profile?.time_selection?.end_year) || JRC_YEARLY_MAX_YEAR;
    return {
      mode,
      month,
      start_date: formatMonthDate(2000, month),
      end_date: nextMonthDate(2000, month),
      valueLabel: `${getMonthLabel(month)} recurrence (${startYear}\u2013${endYear})`,
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

export default function useAgentLayerManagerGroups({
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
}) {
  return useMemo(() => {
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
      const monthSliderControl = ['month', 'calendar_month'].includes(catalogDateWindow.mode) ? {
        range: false,
        selectionMode: 'point',
        label: 'Month',
        value: catalogDateWindow.month,
        valueLabel: catalogDateWindow.mode === 'calendar_month'
          ? catalogDateWindow.valueLabel
          : `${catalogDateWindow.year} ${getMonthLabel(catalogDateWindow.month)}`,
        min: 1,
        max: 12,
        step: 1,
        marks: MONTH_SLIDER_MARKS,
        dots: true,
        disabled: !hasCatalogScope,
        helpText: catalogDateWindow.mode === 'calendar_month'
          ? 'This product aggregates the selected calendar month across 1984-2021.'
          : 'Monthly products use the selected year and month.',
        fields: catalogDateWindow.mode === 'calendar_month' ? [] : [
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
                ...(catalogDateWindow.mode === 'month'
                  ? { year: current.year ?? catalogDateWindow.year }
                  : {}),
                month: getMonthFromDate(
                  `2000-${String(nextMonth).padStart(2, '0')}-01`,
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
    setCatalogLayerTimeOverrides,
    setHotspotYearRange,
    setSingleInundationTimeWindow,
    setWarning,
  ]);
}
