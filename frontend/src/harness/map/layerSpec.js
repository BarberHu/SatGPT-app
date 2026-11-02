const GEE_TILE = /^https:\/\/earthengine\.googleapis\.com\/v1\/projects\/[\w./-]+\/tiles\/\{z\}\/\{x\}\/\{y\}$/;

export function normalizeLayer(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Layer must be an object');
  const id = String(spec.id || globalThis.crypto?.randomUUID?.() || Date.now());
  if (!/^[\w-]{1,120}$/.test(id)) throw new TypeError('Invalid layer ID');
  const name = String(spec.name || id).slice(0, 100);
  const kind = spec.kind || (spec.url?.includes('earthengine.googleapis.com') ? 'gee' : 'raster');
  if (!['gee', 'raster', 'geojson', 'vector'].includes(kind)) throw new TypeError('Unsupported layer kind');
  if (kind === 'gee' && !GEE_TILE.test(spec.url || '')) throw new TypeError('Invalid GEE tile URL');
  if (kind === 'raster' && !/^https:\/\//.test(spec.url || '')) throw new TypeError('Raster tiles require HTTPS');
  if (kind === 'geojson' && (!spec.data || !['Feature', 'FeatureCollection'].includes(spec.data.type))) {
    throw new TypeError('GeoJSON layer requires a Feature or FeatureCollection');
  }
  if (kind === 'vector' && (!/^https:\/\//.test(spec.url || '') || !spec.sourceLayer)) {
    throw new TypeError('Vector layer requires HTTPS tiles and sourceLayer');
  }
  const opacity = Number(spec.opacity ?? 0.8);
  if (!Number.isFinite(opacity)) throw new TypeError('Invalid layer opacity');
  const renderAs = ['line', 'fill', 'circle'].includes(spec.renderAs) ? spec.renderAs : 'line';
  return {
    id, name, kind, url: spec.url || null, data: spec.data || null,
    sourceLayer: spec.sourceLayer || null, visible: spec.visible !== false,
    renderAs, opacity: Math.max(0, Math.min(1, opacity)),
    bounds: Array.isArray(spec.bounds) ? spec.bounds : null,
  };
}
