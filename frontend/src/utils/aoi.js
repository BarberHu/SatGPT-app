const AOI_VERSION = 1;

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

export const buildAoiFromGridSelection = (coordinates, overrides = {}) => {
  const ring = closePolygonRing(coordinates);
  const bounds = getBoundsFromRing(ring);

  if (!ring.length || !bounds) {
    return null;
  }

  return {
    version: AOI_VERSION,
    source: overrides.source || 'fishnet',
    kind: 'polygon',
    label: overrides.label || 'Fishnet selection',
    bounds,
    geojson: {
      type: 'Feature',
      properties: {
        source: overrides.source || 'fishnet',
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
    return parsed.geojson;
  }

  if (parsed.legacy?.AoI_cords) {
    return {
      type: 'Polygon',
      coordinates: [closePolygonRing(parsed.legacy.AoI_cords)],
    };
  }

  return null;
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
