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
import { downloadAgentRasterFile, getFloodImages, getFloodImpact, renderRecommendedLayer } from '../services/agentApi';
import { getAgentRasterLayers } from '../services/api';
import { buildAoiFromAgentState, buildAskMapRequestParams, buildEarthEngineGeometryExpression } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import {
  buildCatalogLegendModel,
  getCatalogMapLayerId,
  sortCatalogLayers,
} from '../utils/catalogLayers';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import SOURCE_REFERENCES from '../config/agentLayerSourceReferences';
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
  {
    key: 'populationDensity',
    orderId: 'agent-raster-populationDensity',
    title: 'Population Density',
    infoText: 'CIESIN GPWv4.11 population density for rapid exposure context.',
    dataset: SOURCE_REFERENCES.populationDensity.datasetId,
    method: 'AOI clipped raster overlay',
    sourceRef: SOURCE_REFERENCES.populationDensity,
    legend: CORE_LAYER_LEGENDS.population_density,
  },
  {
    key: 'lclu',
    orderId: 'agent-raster-lclu',
    title: 'LCLU',
    infoText: 'ESA WorldCover land cover classification clipped to the selected AOI.',
    dataset: SOURCE_REFERENCES.lclu.datasetId,
    method: 'Categorical land-cover raster clipped to AOI',
    sourceRef: SOURCE_REFERENCES.lclu,
    legend: CORE_LAYER_LEGENDS.lclu_raster,
  },
  {
    key: 'soilTexture',
    orderId: 'agent-raster-soilTexture',
    title: 'Soil Texture',
    infoText: 'Soil texture class layer for infiltration and runoff context.',
    dataset: SOURCE_REFERENCES.soilTexture.datasetId,
    method: 'Soil class raster clipped to AOI',
    sourceRef: SOURCE_REFERENCES.soilTexture,
    legend: CORE_LAYER_LEGENDS.soil_texture,
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

const normalizeInfoRows = (rows = []) => (Array.isArray(rows) ? rows : [])
  .map((row) => {
    const value = formatInfoValue(row?.value);
    if (!row?.label || !value) {
      return null;
    }
    return { label: row.label, value };
  })
  .filter(Boolean);

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

const buildLayerInfoPanelModel = (item) => {
  const summary = item.infoText || item.detailText || null;
  const sections = Array.isArray(item.infoSections) ? item.infoSections.filter(Boolean) : [];
  const warnings = (Array.isArray(item.infoWarnings) ? item.infoWarnings : [])
    .map(formatInfoValue)
    .filter(Boolean);
  const links = (Array.isArray(item.infoLinks) ? item.infoLinks : [])
    .filter((link) => link?.href && link?.label);
  const actions = (Array.isArray(item.infoActions) ? item.infoActions : [])
    .filter((action) => action?.label && typeof action?.onClick === 'function');

  return {
    kicker: item.infoKicker || item.badge || item.status || 'Layer',
    title: item.infoTitle || item.title,
    meta: item.infoMeta || null,
    summary,
    rows: normalizeInfoRows(item.infoDetails),
    sections,
    warnings,
    links,
    actions,
    legend: item.legend || null,
  };
};

function LayerInfoPanel({ item }) {
  const panel = buildLayerInfoPanelModel(item);

  return (
    <div className="layer-info-card">
      <div className="layer-info-card-header">
        <div className="layer-info-card-kicker">{panel.kicker}</div>
        <div className="layer-info-card-title">{panel.title}</div>
        {panel.meta ? (
          <div className="layer-info-card-meta">{panel.meta}</div>
        ) : null}
      </div>

      {panel.summary ? (
        <div className="layer-info-card-summary">{panel.summary}</div>
      ) : null}

      {panel.rows.length ? (
        <div className="layer-info-card-table">
          {panel.rows.map((row) => (
            <div className="layer-info-card-row" key={`${row.label}-${row.value}`}>
              <span className="layer-info-card-key">{row.label}</span>
              <span className="layer-info-card-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {panel.legend ? (
        <div className="layer-info-card-section">
          <div className="layer-info-card-section-title">Legend</div>
          <LayerManagerLegend legendModel={panel.legend} />
        </div>
      ) : null}

      {panel.sections.map((section) => {
        const rows = normalizeInfoRows(section.rows);
        if (!rows.length && !section.text) {
          return null;
        }
        return (
          <div className="layer-info-card-section" key={section.title}>
            <div className="layer-info-card-section-title">{section.title}</div>
            {section.text ? (
              <div className="layer-info-card-section-text">{section.text}</div>
            ) : null}
            {rows.length ? (
              <div className="layer-info-card-mini-table">
                {rows.map((row) => (
                  <div className="layer-info-card-row compact" key={`${section.title}-${row.label}-${row.value}`}>
                    <span className="layer-info-card-key">{row.label}</span>
                    <span className="layer-info-card-value">{row.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {panel.warnings.length ? (
        <div className="layer-info-card-warning">
          <span className="layer-info-card-warning-label">Cautions</span>
          {panel.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      {panel.links.length || panel.actions.length ? (
        <div className="layer-info-card-actions">
          {panel.actions.map((action) => (
            <div className="layer-info-card-action-wrap" key={action.key || action.label}>
              <button
                type="button"
                className={`layer-info-card-link layer-info-card-action ${action.status ? `is-${action.status}` : ''}`}
                onClick={action.onClick}
                disabled={Boolean(action.disabled)}
                title={action.title}
              >
                {action.status === 'preparing' ? (
                  <i className="fa fa-spinner fa-spin" aria-hidden="true" />
                ) : action.status === 'success' ? (
                  <i className="fa fa-check" aria-hidden="true" />
                ) : action.status === 'error' ? (
                  <i className="fa fa-exclamation-triangle" aria-hidden="true" />
                ) : (
                  <i className="fa fa-download" aria-hidden="true" />
                )}
                <span>{action.label}</span>
              </button>
              {action.message ? (
                <div className={`layer-info-card-action-message ${action.status ? `is-${action.status}` : ''}`}>
                  {action.message}
                </div>
              ) : null}
            </div>
          ))}
          {panel.links.map((link) => (
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              key={`${link.label}-${link.href}`}
              className="layer-info-card-link"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InlineInfoTooltip({ item }) {
  const [visible, setVisible] = useState(false);
  const panel = useMemo(() => buildLayerInfoPanelModel(item), [item]);

  const openPanel = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setVisible(true);
  }, []);

  const closePanel = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setVisible(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible]);

  const handleTriggerKeyDown = useCallback((event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      openPanel(event);
    }
  }, [openPanel]);

  const popoverContent = visible ? createPortal(
    <div
      className="layer-info-modal-backdrop"
      role="presentation"
      onMouseDown={closePanel}
    >
      <div
        className="layer-info-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Layer information: ${panel.title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="layer-info-modal-close"
          aria-label="Close layer information"
          onClick={closePanel}
        >
          x
        </button>
        <LayerInfoPanel item={item} />
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span className="layer-manager-item-info-wrap">
      <span
        className="layer-manager-item-info"
        aria-label={`Layer information: ${panel.title}`}
        role="button"
        tabIndex={0}
        onClick={openPanel}
        onKeyDown={handleTriggerKeyDown}
      >
        !
      </span>
      {popoverContent}
    </span>
  );
}

function LayerManagerItemCopy({ item }) {
  return (
    <div className="layer-manager-item-copy">
      <div className="layer-manager-item-head">
        <span className="layer-manager-item-title">{item.title}</span>
        {item.infoText ? (
          <InlineInfoTooltip item={item} />
        ) : null}
      </div>
      <LayerManagerLegend legendModel={item.legend} />
      {item.detailText ? (
        <div className="layer-manager-item-detail">{item.detailText}</div>
      ) : null}
      {item.durationControl ? (
        <LayerDurationControl control={item.durationControl} />
      ) : null}
    </div>
  );
}

function LayerDurationControl({ control }) {
  if (!control) {
    return null;
  }

  const percent = ((control.value - control.min) / (control.max - control.min)) * 100;

  return (
    <div className="layer-manager-duration-control" onClick={(event) => event.stopPropagation()}>
      <div className="layer-manager-duration-label">
        {control.label}
        <span>{control.valueLabel}</span>
      </div>
      <div className="layer-manager-duration-range-wrap">
        <input
          type="range"
          className="layer-manager-duration-range"
          min={control.min}
          max={control.max}
          step={control.step || 1}
          value={control.value}
          disabled={control.disabled}
          onChange={(event) => control.onChange(Number(event.target.value))}
          style={{ '--duration-progress': `${percent}%` }}
        />
      </div>
      <div className="layer-manager-duration-ticks">
        {(control.ticks || []).map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
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

function downloadBlobFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `satgpt_aoi_raster_${new Date().toISOString().split('T')[0]}.tif`;
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
    agentSelectedPeriod,
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
    setAgentTileError,
    mergeLayerData,
    mapInstance,
    businessLayers,
    selectedAOI,
    toggleBusinessLayerVisibility,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
  } = useAppContext();

  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [dragOverState, setDragOverState] = useState({ groupKey: null, targetLayerId: null, position: 'before' });
  const [rasterDownloadState, setRasterDownloadState] = useState({});
  const [hotspotDuration, setHotspotDuration] = useState(5);

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
  const buildAgentRasterRequestParams = useCallback((layerKey, overrides = {}) => {
    if (!selectedAOI) {
      return null;
    }

    const baseParams = buildAskMapRequestParams(selectedAOI, {
      time_start: currentPreDate || '2010-01-01',
      time_end: currentAfterDate || currentPeekDate || '2024-12-31',
      cloud_mask: 'true',
      climatology: 'false',
      month_from: '1',
      month_to: '12',
      ...overrides,
    });

    if (layerKey === 'inundationHotspot') {
      baseParams.year_from = overrides.year_from || 1988;
      baseParams.year_count = overrides.year_count || hotspotDuration;
    }

    return baseParams;
  }, [currentAfterDate, currentPeekDate, currentPreDate, hotspotDuration, selectedAOI]);

  const fetchAgentRasterLayer = useCallback(async (layerKey, overrides = {}) => {
    const params = buildAgentRasterRequestParams(layerKey, overrides);
    if (!params) {
      setWarning('Please select an AOI before loading raster data.');
      return;
    }

    setAgentRasterLoading(true);
    setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: true }));
    try {
      const result = await getAgentRasterLayers(params);
      mergeLayerData(result);
      setWarning('');
    } catch (error) {
      const message = error?.message || 'Raster layer request failed.';
      setWarning(message);
    } finally {
      setAgentRasterLoading(false);
      setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: false }));
    }
  }, [
    buildAgentRasterRequestParams,
    mergeLayerData,
    setAgentLayerLoading,
    setAgentRasterLoading,
    setWarning,
  ]);

  const handleAgentRasterDownload = useCallback(async ({ layerKey, title, requestParams = null }) => {
    if (!selectedAOI) {
      setWarning('Please select an AOI before downloading raster data.');
      return;
    }

    setRasterDownloadState((previous) => ({
      ...previous,
      [layerKey]: {
        status: 'preparing',
        message: 'Preparing AOI GeoTIFF...',
      },
    }));

    try {
      setWarning('');
      const response = await downloadAgentRasterFile({
        layer_key: layerKey,
        aoi: selectedAOI,
        ...(requestParams || {}),
      });
      if (!response?.blob) {
        throw new Error('Raster file was not returned.');
      }

      downloadBlobFile(response.blob, response.filename);
      setRasterDownloadState((previous) => ({
        ...previous,
        [layerKey]: {
          status: 'success',
          message: response.scale ? `Download started at ${response.scale}m resolution.` : 'Download started.',
        },
      }));
      trackUxEvent('download_agent_raster', {
        layerKey,
        title,
        scope: selectedAOI?.label || null,
      });
    } catch (error) {
      const message = error?.message || 'Raster download failed.';
      setRasterDownloadState((previous) => ({
        ...previous,
        [layerKey]: {
          status: 'error',
          message,
        },
      }));
      setWarning(message);
    }
  }, [selectedAOI, setWarning]);
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
    const imageryGroup = {
      key: 'imagery',
      label: 'Imagery',
      items: ['sentinel2', 'sentinel1'].map((type) => {
          const sourceRef = type === 'sentinel2' ? SOURCE_REFERENCES.sentinel2 : SOURCE_REFERENCES.sentinel1;
          const periodSlug = agentSelectedPeriod.replace('_date', '');
          const orderId = `agent-${type === 'sentinel2' ? 's2' : 's1'}-${periodSlug}`;
          const descriptor = agentImagery?.[agentSelectedPeriod]?.[type] || null;
          const visible = Boolean(agentBaseImageryVisibility?.[type]);
          const isAvailable = Boolean(descriptor?.tile_url);
          const isLoading = Boolean(
            visible
            && (
              agentImageryLoading
              || agentLayerLoading?.[`base-imagery-${type}`]
              || agentLayerLoading?.[orderId]
            )
          );

          return {
            id: `base-imagery-${type}`,
            orderId,
            defaultOrder: type === 'sentinel2' ? 0 : 1,
            draggable: true,
            title: type === 'sentinel2' ? 'Optical Imagery' : 'SAR Imagery',
            infoKicker: 'Base imagery',
            infoMeta: `${sourceRef.datasetId}${descriptor?.date ? ` / ${descriptor.date}` : ''}`,
            infoText: type === 'sentinel2'
              ? 'Optical base imagery for visual flood context'
              : 'SAR base imagery for cloud-resistant flood context',
            infoDetails: [
              { label: 'Source', value: sourceRef.producer },
              { label: 'Dataset ID', value: sourceRef.datasetId },
              { label: 'Period', value: selectedPeriodMeta.label },
              { label: 'Date', value: descriptor?.date },
              { label: 'Resolution', value: descriptor?.resolution ? `${descriptor.resolution}m` : sourceRef.resolution },
              { label: 'Content date', value: sourceRef.contentDate },
              { label: 'License', value: sourceRef.license },
              { label: 'Status', value: isAvailable ? (visible ? 'Visible' : 'Ready') : 'Unavailable' },
            ],
            infoSections: [
              {
                title: 'Function',
                text: type === 'sentinel2'
                  ? 'True-color optical context for visual interpretation of water, vegetation, built-up area, and cloud cover.'
                  : 'Radar context for flood analysis when clouds reduce optical visibility.',
              },
              {
                title: 'Overview',
                text: sourceRef.overview,
              },
              {
                title: 'Use in workflow',
                rows: [
                  { label: 'Period', value: selectedPeriodMeta.label },
                  { label: 'Role', value: 'Visual evidence layer' },
                ],
              },
              {
                title: 'Citation',
                text: sourceRef.citation,
              },
            ],
            infoWarnings: type === 'sentinel2'
              ? [sourceRef.cautions]
              : [sourceRef.cautions],
            infoLinks: [
              { label: 'Official catalog', href: sourceRef.officialUrl },
            ],
            legend: CORE_LAYER_LEGENDS[type],
            checked: Boolean(visible && agentShowBaseImagery && isAvailable),
            disabled: !isAvailable,
            loading: isLoading,
            checkboxState: isLoading ? 'loading' : (isAvailable ? 'ready' : 'idle'),
            onToggle: (event) => {
              if (!isAvailable) {
                return;
              }

              const nextVisible = Boolean(event?.target?.checked);
              const nextBaseVisibility = {
                ...(agentBaseImageryVisibility || {}),
                [type]: nextVisible,
              };

              flushSync(() => {
                setAgentSelectedType(type);
                setAgentBaseImageryVisibility(nextBaseVisibility);
                setAgentShowBaseImagery(Object.values(nextBaseVisibility).some(Boolean));
              });

              if (!nextVisible) {
                [
                  `agent-${type === 'sentinel2' ? 's2' : 's1'}-pre`,
                  `agent-${type === 'sentinel2' ? 's2' : 's1'}-peek`,
                  `agent-${type === 'sentinel2' ? 's2' : 's1'}-after`,
                ].forEach(removeMapLayerFromMap);
              }
            },
          };
        }),
    };

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
      const hasScope = Boolean(selectedAOI);
      const hasTile = Boolean(descriptor?.tileUrl);
      const loading = Boolean(
        hasScope
        && (
          agentLayerLoading?.[`raster-${layer.key}`]
          || (visible && agentRasterLoading && !hasTile)
        )
      );
      const downloadState = rasterDownloadState[layer.key] || null;
      const isDownloading = downloadState?.status === 'preparing';
      const requestParams = buildAgentRasterRequestParams(layer.key);
      const durationMeta = layer.key === 'inundationHotspot'
        ? {
          yearFrom: requestParams?.year_from || 1988,
          yearCount: requestParams?.year_count || hotspotDuration,
          yearTo: (requestParams?.year_from || 1988) + (requestParams?.year_count || hotspotDuration),
        }
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
          { label: 'Scope', value: selectedAOI?.label || 'No active scope' },
          { label: 'Date window', value: layer.key === 'singleInundationEvent' ? `${requestParams?.time_start || '2010-01-01'} to ${requestParams?.time_end || '2024-12-31'}` : null },
          { label: 'Hotspot duration', value: durationMeta ? `${durationMeta.yearFrom}-${durationMeta.yearTo} (${durationMeta.yearCount} years)` : null },
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
              { label: 'Active AOI', value: selectedAOI?.label },
              { label: 'Layer role', value: layer.key === 'singleInundationEvent'
                ? 'Historical single-window inundation evidence'
                : layer.key === 'inundationHotspot'
                  ? 'Long-term inundation hotspot context'
                  : 'Context for interpreting flood exposure and environment' },
              { label: 'Duration', value: durationMeta ? `${durationMeta.yearCount} years` : null },
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
        durationControl: layer.hasDurationControl ? {
          label: 'Hotspot duration',
          value: hotspotDuration,
          valueLabel: `${durationMeta?.yearFrom || 1988}-${durationMeta?.yearTo || 1988 + hotspotDuration}`,
          min: 5,
          max: 25,
          step: 1,
          ticks: [5, 10, 15, 20, 25],
          disabled: !hasScope || loading,
          onChange: (nextValue) => {
            setHotspotDuration(nextValue);
            if (agentRasterLayerVisibility?.inundationHotspot) {
              fetchAgentRasterLayer('inundationHotspot', { year_count: nextValue });
            }
          },
        } : null,
        checked: visible,
        disabled: !hasScope,
        loading,
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

    const recommendedItems = confirmedRecommendedCatalogLayers.map((layer, index) => {
      const descriptor = agentRecommendedLayerData?.[layer.id] || null;
      const sourceMeta = mergeCatalogSourceMeta(layer, descriptor);
      const sourceTitle = trimEarthEngineTitle(sourceMeta.title) || layer.title;
      const sourceSummary = sourceMeta.summary || layer.summary;
      const selectedBands = layer.render_profile?.bands || sourceMeta?.legend_spec?.bands;
      const bandRows = buildBandMetadataRows(sourceMeta.band_metadata, selectedBands);
      const visible = Boolean(agentRecommendedLayerVisibility?.[layer.id]);
      const loading = Boolean(visible && agentLayerLoading?.[layer.id]);
      const hasTile = Boolean(descriptor?.tile_url);
      const orderId = getCatalogMapLayerId(layer.id);
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
          { label: 'Coverage', value: sourceMeta.spatial_scope || layer.spatial_scope },
          { label: 'Status', value: !analysisDisplayEnabled ? 'Unavailable' : (loading ? 'Loading' : (visible ? (descriptor?.tile_url ? 'Visible' : 'Pending') : 'Hidden')) },
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
          !analysisDisplayEnabled ? 'Confirm event dates and AOI before rendering this dataset.' : null,
        ],
        infoLinks: [
          { label: 'Official dataset page', href: sourceMeta.official_url || layer.official_url || descriptor?.official_url },
          { label: 'GEE water catalog source', href: sourceMeta.catalog_source_url },
        ].filter((link) => link.href),
        legend: buildCatalogLegendModel(descriptor || layer, layer.title),
        checked: visible,
        disabled: !analysisDisplayEnabled,
        loading,
        checkboxState: !analysisDisplayEnabled ? 'idle' : (loading ? 'loading' : (hasTile ? 'ready' : 'idle')),
        status: !analysisDisplayEnabled
          ? 'Unavailable'
          : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : 'Hidden')),
        tone: !analysisDisplayEnabled
          ? 'idle'
          : (loading ? 'loading' : (visible ? (hasTile ? 'ready' : 'pending') : 'off')),
        badge: layer.ui_profile?.badge_label || null,
        onToggle: (event) => {
          if (analysisDisplayEnabled) {
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
          }
        },
      };
    });

    const overlayItems = orderLayerManagerItems([
      ...floodDetectionItem,
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

    imageryGroup.items = orderLayerManagerItems(imageryGroup.items);
    groups.push(imageryGroup);

    groups.push({
      key: 'scopes',
      label: 'Vector Layers',
      items: (businessLayers || []).map((layer) => {
        const isVisible = layer.is_visible !== false;
        return {
          id: `scope-${layer.id}`,
          title: layer.label,
          detailText: scopeSourceLabel(layer.source),
          infoKicker: 'Vector layer',
          infoMeta: layer.source || 'business layer',
          infoText: 'User-managed vector scope used to constrain flood analysis and map rendering.',
          infoDetails: [
            { label: 'Source', value: scopeSourceLabel(layer.source) },
            { label: 'Status', value: isVisible ? 'Visible' : 'Hidden' },
            { label: 'Active', value: layer.is_active },
          ],
          infoSections: [
            {
              title: 'Use in workflow',
              rows: [
                { label: 'Role', value: 'AOI / business scope' },
                { label: 'Can constrain analysis', value: true },
                { label: 'Created', value: layer.created_at },
                { label: 'Updated', value: layer.updated_at },
              ],
            },
          ],
          legend: CORE_LAYER_LEGENDS.vector_scope,
          checked: isVisible,
          disabled: false,
          loading: false,
          checkboxState: 'ready',
          status: isVisible ? 'Visible' : 'Hidden',
          tone: isVisible ? 'ready' : 'off',
          actionLabel: 'Delete',
          onToggle: () => toggleBusinessLayerVisibility(layer.id),
          onSelect: () => activateBusinessLayerRecord(layer.id),
          onAction: () => deleteBusinessLayer(layer.id),
        };
      }),
    });

    return groups;
  }, [
    agentImageryLoading,
    agentImagery,
    agentBaseImageryVisibility,
    agentLayerLoading,
    agentRasterLayerVisibility,
    agentRasterLoading,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentShowBaseImagery,
    analysisDisplayEnabled,
    businessLayers,
    confirmedRecommendedCatalogLayers,
    currentPeekDate,
    currentPreDate,
    layerData,
    orderLayerManagerItems,
    rasterDownloadState,
    scopeSourceLabel,
    agentSelectedPeriod,
    agentShowFloodDetection,
    buildAgentRasterRequestParams,
    handleAgentRasterDownload,
    fetchAgentRasterLayer,
    hotspotDuration,
    selectedPeriodMeta.label,
    selectedAOI,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
    removeMapLayerFromMap,
    setAgentRasterLayerVisibility,
    setAgentBaseImageryVisibility,
    setAgentRecommendedLayerVisibility,
    setAgentSelectedType,
    setAgentShowBaseImagery,
    setAgentShowFloodDetection,
    setHotspotDuration,
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
      const selectedIds = new Set(currentSelectedLayerIds);
      const next = {};
      currentRecommendedLayers.forEach((layer) => {
        if (layer.layer_family === 'catalog') {
          next[layer.id] = selectedIds.has(layer.id);
        }
      });
      return next;
    });
  }, [
    analysisDisplayEnabled,
    currentConfirmationVersion,
    currentSelectedLayerIds,
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
                  </div>
                  <div className="layer-manager-items">
                    {group.items.map((item) => {
                        const visibleOrderIds = group.items.filter((entry) => entry.draggable).map((entry) => entry.orderId);
                        const canReceiveDrop = (
                          ['overlays', 'imagery'].includes(group.key)
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
                            className={`layer-manager-item ${item.checked ? 'is-visible' : 'is-hidden'} ${item.disabled ? 'is-disabled' : ''} ${draggedLayerId === item.orderId ? 'is-dragging' : ''} ${isDragOverTarget && dragOverState.position === 'before' ? 'is-drag-over-before' : ''} ${isDragOverTarget && dragOverState.position === 'after' ? 'is-drag-over-after' : ''}`}
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
                                  disabled={item.disabled}
                                />
                              </div>
                              <div className="layer-manager-item-content">
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


