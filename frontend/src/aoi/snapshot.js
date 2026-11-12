import { buildAoiFromGeoJSON } from '../utils/aoi.js';

export const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
export const newAoiId = () => globalThis.crypto?.randomUUID?.() || `area-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** A detached selection. The library reference is provenance, never a geometry lookup. */
export function aoiSnapshot(input, overrides = {}) {
  if (!input) return null;
  const aoi = buildAoiFromGeoJSON(input.geojson || input, {
    id: overrides.id || input.id || newAoiId(),
    source: input.source || 'upload', label: overrides.label || input.label || 'Analysis area',
    created_at: input.created_at, updated_at: input.updated_at,
  });
  if (!aoi) throw new Error('Choose a valid longitude/latitude Polygon or MultiPolygon.');
  return clone({ ...aoi, aoi_ref: input.aoi_ref || null, edit_ref: input.edit_ref || null });
}

export const snapshotFromRecord = record => aoiSnapshot({ ...record, aoi_ref: { id: record.id, revision: record.revision }, edit_ref: null });
export const aoiMetadata = aoi => aoi ? { label: aoi.label, ...(aoi.aoi_ref || {}) } : null;
export const exportAoiGeoJSON = record => clone({ ...record.geojson,
  properties: { ...record.geojson.properties, label: record.label, id: record.id,
    revision: record.revision, source: record.source } });
export const basicSelectionKey = 'satgpt:basic-study-area:v2';

export function readBasicSelection(storage) {
  const current = storage?.getItem(basicSelectionKey);
  if (current != null) {
    const value = JSON.parse(current);
    if (value?.schema_version !== 2 || !Object.hasOwn(value, 'aoi')) throw new Error('Unrecognized saved selection.');
    return { aoi: aoiSnapshot(value.aoi), outlineVisible: value.outline_visible !== false };
  }
  const old = storage?.getItem('satgpt:basic-study-area:v1');
  return { aoi: old ? aoiSnapshot(JSON.parse(old)) : null, outlineVisible: true };
}

export function writeBasicSelection(storage, aoi, outlineVisible) {
  storage?.setItem(basicSelectionKey, JSON.stringify({ schema_version: 2, aoi, outline_visible: outlineVisible }));
}
