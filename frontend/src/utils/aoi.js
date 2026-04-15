const AOI_VERSION = 1;
const createAoiId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `aoi-${Date.now()}`;

const isCoordinatePair = (value) =>
  Array.isArray(value) &&
  value.length >= 2 &&
  Number.isFinite(Number(value[0])) &&
  Number.isFinite(Number(value[1]));

export const closePolygonRing = (coordinates = []) => {
  const normalized = coordinates
    .filter(isCoordinatePair)
    .map(([lng, lat]) => [Number(lng), Number(lat)]);

  if (normalized.length === 0) {
    return [];
  }

  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    normalized.push([...first]);
  }

  return normalized;
};

export const getBoundsFromRing = (coordinates = []) => {
  const ring = closePolygonRing(coordinates);
  if (!ring.length) {
    return null;
  }

  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);

  return {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  };
};

export const getCenterFromBounds = (bounds) => {
  if (!bounds) {
    return null;
  }

  const west = Number(bounds.west);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const north = Number(bounds.north);

  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }

  return {
    lng: (west + east) / 2,
    lat: (south + north) / 2,
  };
};

const mergeBounds = (boundsList = []) => {
  const validBounds = boundsList.filter(Boolean);
  if (!validBounds.length) {
    return null;
  }

  return {
    west: Math.min(...validBounds.map((bounds) => bounds.west)),
    south: Math.min(...validBounds.map((bounds) => bounds.south)),
    east: Math.max(...validBounds.map((bounds) => bounds.east)),
    north: Math.max(...validBounds.map((bounds) => bounds.north)),
  };
};

const normalizePolygon = (coordinates = []) => {
  const shell = closePolygonRing(coordinates[0] || []);
  if (!shell.length) {
    return null;
  }

  const holes = (coordinates || [])
    .slice(1)
    .map((ring) => closePolygonRing(ring))
    .filter((ring) => ring.length >= 4);

  return [shell, ...holes];
};

const getBoundsFromPolygonCoordinates = (coordinates = []) => {
  const shell = coordinates[0] || [];
  return getBoundsFromRing(shell);
};

const geometryToMultiPolygonCoordinates = (geometry) => {
  if (!geometry || typeof geometry !== 'object') {
    return [];
  }

  if (geometry.type === 'Polygon') {
    const polygon = normalizePolygon(geometry.coordinates || []);
    return polygon ? [polygon] : [];
  }

  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || [])
      .map((polygon) => normalizePolygon(polygon))
      .filter(Boolean);
  }

  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).flatMap((item) => geometryToMultiPolygonCoordinates(item));
  }

  return [];
};

export const normalizeGeoJSONGeometry = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const type = input.type;

  if (type === 'FeatureCollection') {
    const polygons = (input.features || [])
      .flatMap((feature) => normalizeGeoJSONGeometry(feature))
      .flatMap((geometry) => geometryToMultiPolygonCoordinates(geometry));

    if (!polygons.length) {
      return null;
    }

    if (polygons.length === 1) {
      return { type: 'Polygon', coordinates: polygons[0] };
    }

    return { type: 'MultiPolygon', coordinates: polygons };
  }

  if (type === 'Feature') {
    return normalizeGeoJSONGeometry(input.geometry);
  }

  if (type === 'Polygon' || type === 'MultiPolygon' || type === 'GeometryCollection') {
    const polygons = geometryToMultiPolygonCoordinates(input);

    if (!polygons.length) {
      return null;
    }

    if (polygons.length === 1) {
      return { type: 'Polygon', coordinates: polygons[0] };
    }

    return { type: 'MultiPolygon', coordinates: polygons };
  }

  return null;
};

export const getBoundsFromGeometry = (geometry) => {
  if (!geometry) {
    return null;
  }

  if (geometry.type === 'Polygon') {
    return getBoundsFromPolygonCoordinates(geometry.coordinates || []);
  }

  if (geometry.type === 'MultiPolygon') {
    return mergeBounds(
      (geometry.coordinates || []).map((polygon) => getBoundsFromPolygonCoordinates(polygon))
    );
  }

  return null;
};

export const buildAoiFromGeoJSON = (input, overrides = {}) => {
  const geometry = normalizeGeoJSONGeometry(input);
  const bounds = getBoundsFromGeometry(geometry);
  const center = getCenterFromBounds(bounds);

  if (!geometry || !bounds) {
    return null;
  }

  return {
    version: AOI_VERSION,
    id: Object.prototype.hasOwnProperty.call(overrides, 'id')
      ? overrides.id
      : (overrides.generateId === false ? null : createAoiId()),
    source: overrides.source || 'upload',
    kind: geometry.type === 'MultiPolygon' ? 'multipolygon' : 'polygon',
    label: overrides.label || 'Uploaded scope',
    bounds,
    center,
    created_at: overrides.created_at || null,
    updated_at: overrides.updated_at || null,
    origin: overrides.origin || null,
    geojson: {
      type: 'Feature',
      properties: {
        id: overrides.id || null,
        source: overrides.source || 'upload',
        label: overrides.label || 'Uploaded scope',
      },
      geometry,
    },
    legacy: {
      AoI_cords: geometry.type === 'Polygon' ? geometry.coordinates[0] : [],
    },
  };
};

export const buildAoiFromDrawFeature = (feature, overrides = {}) => {
  return buildAoiFromDrawFeatures(feature ? [feature] : [], overrides);
};

export const buildAoiFromDrawFeatures = (features = [], overrides = {}) => {
  if (!Array.isArray(features) || !features.length) {
    return null;
  }

  const collection = {
    type: 'FeatureCollection',
    features: features
      .map((feature) => (feature?.type === 'Feature' ? feature : {
        type: 'Feature',
        properties: feature?.properties || {},
        geometry: feature?.geometry || feature,
      }))
      .filter((feature) => feature?.geometry?.type === 'Polygon'),
  };

  if (!collection.features.length) {
    return null;
  }

  return buildAoiFromGeoJSON(collection, {
    id: overrides.id,
    source: overrides.source || 'draw',
    label: overrides.label || 'Drawn scope',
  });
};

export const getDrawFeaturesFromAoi = (aoi) => {
  const geometry = getAoiGeometry(aoi);
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return [{
      type: 'Feature',
      properties: {},
      geometry,
    }];
  }

  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).map((polygon, index) => ({
      type: 'Feature',
      properties: { polygonIndex: index },
      geometry: {
        type: 'Polygon',
        coordinates: polygon,
      },
    }));
  }

  return [];
};

export const buildAoiFromDrawFeatureLegacy = (feature, overrides = {}) => {
  if (!feature || typeof feature !== 'object') {
    return null;
  }

  const geometry = feature.type === 'Feature' ? feature.geometry : feature;
  if (!geometry || geometry.type !== 'Polygon') {
    return null;
  }

  return buildAoiFromGeoJSON(
    {
      type: 'Feature',
      properties: feature.properties || {},
      geometry,
    },
    {
      id: overrides.id,
      source: overrides.source || 'draw',
      label: overrides.label || 'Drawn scope',
    }
  );
};

export const buildAoiFromBounds = (bounds, overrides = {}) => {
  if (!bounds) {
    return null;
  }

  const requiredKeys = ['west', 'south', 'east', 'north'];
  const hasBounds = requiredKeys.every((key) => Number.isFinite(Number(bounds[key])));

  if (!hasBounds) {
    return null;
  }

  const ring = closePolygonRing([
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
  ]);

  return buildAoiFromGridSelection(ring, {
    source: overrides.source || 'bounds',
    label: overrides.label || 'Bounding box scope',
  });
};

export const buildAoiFromGridSelection = (coordinates, overrides = {}) => {
  const ring = closePolygonRing(coordinates);
  const bounds = getBoundsFromRing(ring);
  const center = getCenterFromBounds(bounds);

  if (!ring.length || !bounds) {
    return null;
  }

  const source = overrides.source || 'fishnet';
  const id = Object.prototype.hasOwnProperty.call(overrides, 'id')
    ? overrides.id
    : createAoiId();
  const createdAt = overrides.created_at || new Date().toISOString();
  const updatedAt = overrides.updated_at || createdAt;
  const origin = overrides.origin || (source === 'bounds' ? 'draw' : source);

  return {
    version: AOI_VERSION,
    id,
    source,
    kind: 'polygon',
    label: overrides.label || 'Fishnet selection',
    bounds,
    center,
    created_at: createdAt,
    updated_at: updatedAt,
    origin,
    geojson: {
      type: 'Feature',
      properties: {
        id,
        source,
        label: overrides.label || 'Fishnet selection',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ring],
      },
    },
    legacy: {
      AoI_cords: ring,
    },
  };
};

export const buildAoiFromLegacyCoords = (coordinates) => {
  if (!Array.isArray(coordinates)) {
    return null;
  }

  return buildAoiFromGridSelection(coordinates, {
    source: 'legacy_polygon',
    label: 'Legacy polygon selection',
  });
};

export const buildAoiFromAgentState = (state, overrides = {}) => {
  if (!state) {
    return null;
  }

  const preferredAoi = state.confirmed_aoi || state.resolved_aoi || null;

  if (preferredAoi?.geojson) {
    return parseSerializedAoi(preferredAoi);
  }

  if (state.geojson) {
    return buildAoiFromGeoJSON(state.geojson, {
      generateId: false,
      source: overrides.source || 'agent_geocode',
      label: overrides.label || state.location || 'Agent-derived scope',
    });
  }

  if (state.bounds) {
    return buildAoiFromBounds(state.bounds, {
      source: overrides.source || 'agent_bounds',
      label: overrides.label || state.location || 'Agent-derived bounds',
    });
  }

  return null;
};

export const parseSerializedAoi = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  return value;
};

export const getAoiGeometry = (aoi) => {
  const parsed = parseSerializedAoi(aoi);
  if (!parsed) {
    return null;
  }

  if (parsed.geojson?.type === 'Feature') {
    return parsed.geojson.geometry || null;
  }

  if (parsed.geojson) {
    return parsed.geojson.type === 'Feature' ? parsed.geojson.geometry || null : parsed.geojson;
  }

  if (parsed.legacy?.AoI_cords) {
    return {
      type: 'Polygon',
      coordinates: [closePolygonRing(parsed.legacy.AoI_cords)],
    };
  }

  return null;
};

export const getAoiLabel = (aoi) => {
  const parsed = parseSerializedAoi(aoi);
  if (!parsed) {
    return 'No spatial scope selected';
  }

  return parsed.label || parsed.geojson?.properties?.label || parsed.source || 'Spatial scope selected';
};

export const buildAskMapRequestParams = (aoi, extraParams = {}) => {
  const parsed = parseSerializedAoi(aoi);
  if (!parsed) {
    throw new Error('AOI is required to build map request params');
  }

  return {
    ...extraParams,
    aoi: JSON.stringify(parsed),
    AoI_cords: JSON.stringify(parsed.legacy?.AoI_cords || []),
  };
};

export const buildEarthEngineGeometryExpression = (aoi) => {
  const geometry = getAoiGeometry(aoi);
  if (!geometry) {
    throw new Error('AOI geometry is required for GEE code generation');
  }

  if (geometry.type === 'Polygon') {
    return `ee.Geometry.Polygon(${JSON.stringify(geometry.coordinates)})`;
  }

  if (geometry.type === 'MultiPolygon') {
    return `ee.Geometry.MultiPolygon(${JSON.stringify(geometry.coordinates)})`;
  }

  return `ee.Geometry(${JSON.stringify(geometry)})`;
};
