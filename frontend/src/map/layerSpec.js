import { layerPresentation, previewUrl } from './layerPresentation';
import { normalizeRoadLevels } from './roadLevels';
const GEE_TILE = /^https:\/\/earthengine\.googleapis\.com\/v1\/projects\/[\w./-]+\/tiles\/\{z\}\/\{x\}\/\{y\}$/;
const OSM_RESULT = /^\/api\/harness\/conversations\/webgis-[a-f0-9]{32}\/tasks\/[a-f0-9]{32}\/osm\/[a-f0-9]{32}\.geojson$/;
const FLEXTH_RESULT = /^\/api\/harness\/conversations\/webgis-[a-f0-9]{32}\/tasks\/[a-f0-9]{32}\/flexth\/[a-f0-9]{32}-(?:depth|extent)\.tif$/;
export const MAPBOX_STREETS_V8 = 'mapbox://mapbox.mapbox-streets-v8';
export const BUILDING_FOOTPRINT_MIN_ZOOM = 13;

export function normalizeLayer(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Layer must be an object');
  const id = String(spec.id || globalThis.crypto?.randomUUID?.() || Date.now());
  if (!/^[\w-]{1,120}$/.test(id)) throw new TypeError('Invalid layer ID');
  const name = String(spec.name || id).slice(0, 100);
  const kind = spec.kind || (spec.url?.includes('earthengine.googleapis.com') ? 'gee' : 'raster');
  if (!['gee', 'raster', 'geojson', 'vector', 'image'].includes(kind)) throw new TypeError('Unsupported layer kind');
  if (kind === 'gee' && !GEE_TILE.test(spec.url || '')) throw new TypeError('Invalid GEE tile URL');
  if (kind === 'raster' && !/^https:\/\//.test(spec.url || '')) throw new TypeError('Raster tiles require HTTPS');
  const dataUrl = kind === 'geojson' && typeof spec.data_url === 'string' && OSM_RESULT.test(spec.data_url) ? spec.data_url : null;
  if (kind === 'geojson' && !dataUrl && !['Feature', 'FeatureCollection'].includes(spec.data?.type)) {
    throw new TypeError('GeoJSON layer requires a Feature, FeatureCollection or a task result');
  }
  if (kind === 'vector' && (!(spec.url === MAPBOX_STREETS_V8 || /^https:\/\//.test(spec.url || '')) || !spec.sourceLayer)) {
    throw new TypeError('Vector layer requires an approved tile source and sourceLayer');
  }
  const streets = kind === 'vector' && spec.url === MAPBOX_STREETS_V8;
  const roadLevels = streets && spec.sourceLayer === 'road' && Array.isArray(spec.roadLevels)
    ? normalizeRoadLevels(spec.roadLevels) : null;
  const bounds = Array.isArray(spec.bounds) ? spec.bounds : null;
  const imageBounds = kind === 'image' ? spec.image_bounds : null;
  if (kind === 'image' && (!previewUrl(spec.url) || !Array.isArray(imageBounds) || imageBounds.length !== 4
      || !imageBounds.every(Number.isFinite) || imageBounds[0] >= imageBounds[2] || imageBounds[1] >= imageBounds[3]
      || imageBounds[0] < -180 || imageBounds[2] > 180 || imageBounds[1] < -90 || imageBounds[3] > 90)) {
    throw new TypeError('Image overlay requires a task preview and valid bounds');
  }
  const clippedBuildings = streets && spec.sourceLayer === 'building' && spec.bounds != null;
  if ((roadLevels || clippedBuildings) && (bounds?.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3])) {
    throw new TypeError('A grid tile overlay requires valid grid bounds');
  }
  const opacity = Number(spec.opacity ?? 0.8);
  if (!Number.isFinite(opacity)) throw new TypeError('Invalid layer opacity');
  const renderAs = ['line', 'fill', 'circle'].includes(spec.renderAs) ? spec.renderAs : 'line';
  return {
    ...layerPresentation(spec),
    id, name, kind, url: spec.url || null, data: spec.data || null, dataUrl,
    sourceLayer: spec.sourceLayer || null, visible: spec.visible !== false,
    renderAs, opacity: Math.max(0, Math.min(1, opacity)),
    bounds, roadLevels, imageBounds,
    depthUrl: kind === 'image' && FLEXTH_RESULT.test(spec.depth_url || '') ? spec.depth_url : null,
    extentUrl: kind === 'image' && FLEXTH_RESULT.test(spec.extent_url || '') ? spec.extent_url : null,
    code: typeof spec.code === 'string' ? spec.code : spec.generation?.code || '',
    generation: spec.generation || null, reloadable: spec.reloadable === true,
    reloadUnavailableReason: spec.reload_unavailable_reason || '',
    reloadVersion: Number(spec.reload_version ?? spec.reloadVersion) || 0,
    reloadedAt: spec.reloaded_at || spec.reloadedAt || null,
  };
}
