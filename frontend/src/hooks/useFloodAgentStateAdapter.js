import { useMemo, useRef } from 'react';
import { buildAoiBoundsSignature } from '../utils/aoi';
import { DEFAULT_FLOOD_AGENT_STATE } from '../config/floodAgentState';

const EMPTY_ARRAY = [];

export const formatCoordinatePart = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(6) : '';
};

export const buildLayerSignature = (layers = []) => (layers || [])
  .map((layer) => [
    layer?.id || '',
    layer?.layer_family || '',
    layer?.title || '',
    layer?.default_selected ? '1' : '0',
  ].join('~'))
  .join('|');

export const buildSelectedLayerSignature = (layerIds = []) => (layerIds || []).join('|');

export const buildRecommendedLayerContextKey = ({
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

export const areAoiScopesEquivalent = (left, right) => {
  if (!left || !right) {
    return false;
  }

  if (left.id && right.id) {
    return left.id === right.id;
  }

  return buildAoiBoundsSignature(left.bounds) === buildAoiBoundsSignature(right.bounds);
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
    buildAoiBoundsSignature(fallbackBounds),
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
    buildAoiBoundsSignature(bounds),
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
    buildAoiBoundsSignature(meta.bounds),
  ].join('|');
};

const useStableReference = (value, signature) => {
  const reference = useRef({ signature, value });

  if (reference.current.signature !== signature) {
    reference.current = { signature, value };
  }

  return reference.current.value;
};

export const buildFloodAgentViewState = (state) => ({
  location: state.location,
  coordinates: state.coordinates,
  bounds: state.bounds,
  geojson: state.geojson,
  resolved_aoi: state.resolved_aoi,
  aoi_resolution_meta: state.aoi_resolution_meta,
  confirmed_aoi: state.confirmed_aoi,
  recommended_layers: state.recommended_layers,
  selected_layer_ids: state.selected_layer_ids,
  recommendation_strategy: state.recommendation_strategy,
  recommendation_source: state.recommendation_source,
  confirmation_version: state.confirmation_version,
});

export default function useFloodAgentStateAdapter({ state, fallbackState }) {
  const hasCoAgentState = Boolean(state);
  const rawState = hasCoAgentState ? state : fallbackState;
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
  const preferredAoi = rawConfirmedAoi || rawResolvedAoi || null;
  const boundsSignature = buildAoiBoundsSignature(preferredAoi?.bounds || rawBounds);
  const stableCoordinates = useStableReference(rawCoordinates, [
    formatCoordinatePart(rawCoordinates?.[0]),
    formatCoordinatePart(rawCoordinates?.[1]),
  ].join(':'));
  const stableBounds = useStableReference(rawBounds, boundsSignature);
  const stableGeojson = useStableReference(rawGeojson, buildGeojsonSignature(rawGeojson, rawBounds));
  const stableResolvedAoi = useStableReference(
    rawResolvedAoi,
    buildAoiObjectSignature(rawResolvedAoi, rawBounds)
  );
  const stableAoiResolutionMeta = useStableReference(
    rawAoiResolutionMeta,
    buildResolutionMetaSignature(rawAoiResolutionMeta)
  );
  const stableConfirmedAoi = useStableReference(
    rawConfirmedAoi,
    buildAoiObjectSignature(rawConfirmedAoi, rawBounds)
  );
  const stableRecommendedLayers = useStableReference(
    rawRecommendedLayers,
    buildLayerSignature(rawRecommendedLayers)
  );
  const stableSelectedLayerIds = useStableReference(
    rawSelectedLayerIds,
    buildSelectedLayerSignature(rawSelectedLayerIds)
  );

  const currentState = useMemo(() => ({
    ...DEFAULT_FLOOD_AGENT_STATE,
    event: rawState?.event || null,
    pre_date: rawState?.pre_date || null,
    after_date: rawState?.after_date || null,
    peek_date: rawState?.peek_date || null,
    location: rawState?.location || null,
    coordinates: stableCoordinates,
    bounds: stableBounds,
    geojson: stableGeojson,
    resolved_aoi: stableResolvedAoi,
    confirmed_aoi: stableConfirmedAoi,
    recommended_layers: stableRecommendedLayers,
    selected_layer_ids: stableSelectedLayerIds,
    recommendation_strategy: rawState?.recommendation_strategy || null,
    recommendation_source: rawState?.recommendation_source || null,
    confirmation_version: rawState?.confirmation_version || 0,
    gee_code: rawState?.gee_code || null,
  }), [
    rawState?.after_date,
    rawState?.confirmation_version,
    rawState?.event,
    rawState?.gee_code,
    rawState?.location,
    rawState?.peek_date,
    rawState?.pre_date,
    rawState?.recommendation_source,
    rawState?.recommendation_strategy,
    stableBounds,
    stableConfirmedAoi,
    stableCoordinates,
    stableGeojson,
    stableRecommendedLayers,
    stableResolvedAoi,
    stableSelectedLayerIds,
  ]);

  const viewState = useMemo(() => buildFloodAgentViewState({
    ...currentState,
    aoi_resolution_meta: stableAoiResolutionMeta,
  }), [currentState, stableAoiResolutionMeta]);

  return { currentState, hasCoAgentState, viewState };
}
