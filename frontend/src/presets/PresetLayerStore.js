import { PRESET_VERSION, presetById, validPresetParams } from '../config/presetLayerCatalog';
import { normalizeGeoJSONGeometry, buildAoiFromGeoJSON } from '../utils/aoi';

export const PRESET_STORAGE_KEY = 'satgpt:basic-presets:v1';
const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const aoiKey = aoi => JSON.stringify(canonical(normalizeGeoJSONGeometry(aoi?.geojson)));
export const presetRequestKey = (id, aoi, params) => JSON.stringify([PRESET_VERSION, id, aoiKey(aoi), canonical(params)]);

/** Owns requests and rebuildable selections, independently of chat and map engines. */
export class PresetLayerStore {
  constructor(request, storage = defaultStorage(), limit = 2) {
    this.request = request; this.storage = storage; this.limit = limit;
    this.rows = []; this.listeners = new Set(); this.running = 0; this.sequence = 0; this.started = false; this.active = true;
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.rows;
  emit(persist = true) {
    try { if (persist) this.storage?.setItem(PRESET_STORAGE_KEY, JSON.stringify(this.rows.map(({ id, presetId, aoi, params, visible, opacity }) =>
      ({ id, presetId, aoi: { id: aoi.id, aoi_ref: aoi.aoi_ref, geojson: aoi.geojson, label: aoi.label, source: aoi.source }, params, visible, opacity })))); } catch { /* Optional persistence. */ }
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.started) return;
    this.started = true;
    let saved;
    try { saved = JSON.parse(this.storage?.getItem(PRESET_STORAGE_KEY) || '[]'); } catch { saved = []; }
    if (Array.isArray(saved)) for (const row of [...saved].reverse()) {
      try { this.add(row.presetId, row.aoi, row.params, null, row); } catch { /* Skip obsolete/corrupt selections. */ }
    }
  }
  add(presetId, inputAoi, inputParams, replaceId = null, saved = {}) {
    const preset = presetById(presetId);
    if (!preset) throw new Error('This preset is unavailable.');
    const params = validPresetParams(preset, inputParams);
    const aoi = buildAoiFromGeoJSON(inputAoi?.geojson, { id: inputAoi?.id, source: inputAoi?.source || 'upload', label: String(inputAoi?.label || 'Study area').slice(0, 100) });
    if (!aoi) throw new Error('Select a valid polygon study area first.');
    aoi.aoi_ref = inputAoi?.aoi_ref ? JSON.parse(JSON.stringify(inputAoi.aoi_ref)) : null;
    const requestKey = presetRequestKey(presetId, aoi, params);
    const duplicate = this.rows.find(row => row.requestKey === requestKey && row.id !== replaceId);
    if (duplicate) return duplicate.id;
    const old = this.rows.find(row => row.id === replaceId);
    old?.controller?.abort();
    const row = { id: old?.id || `preset-${++this.sequence}-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      presetId, aoi, params, requestKey, generation: Symbol(), status: 'queued', layer: null,
      visible: old?.visible ?? saved.visible !== false, opacity: old?.opacity ?? (Number.isFinite(saved.opacity) ? Math.min(1, Math.max(0, saved.opacity)) : 0.8), tileStatus: 'waiting' };
    this.rows = old ? this.rows.map(item => item === old ? row : item) : [row, ...this.rows];
    this.emit(); this.pump(); return row.id;
  }
  patch(id, patch) { this.rows = this.rows.map(row => row.id === id ? { ...row, ...patch } : row); this.emit('visible' in patch || 'opacity' in patch); }
  remove(id) { this.rows.find(row => row.id === id)?.controller?.abort(); this.rows = this.rows.filter(row => row.id !== id); this.emit(); }
  retry(id) {
    const row = this.rows.find(item => item.id === id);
    if (row) this.add(row.presetId, row.aoi, row.params, id);
  }
  move(id, offset) {
    const index = this.rows.findIndex(row => row.id === id), next = index + offset;
    if (index < 0 || next < 0 || next >= this.rows.length) return;
    const rows = [...this.rows]; [rows[index], rows[next]] = [rows[next], rows[index]]; this.rows = rows; this.emit();
  }
  pump() {
    if (!this.active) return;
    while (this.running < this.limit) {
      const row = this.rows.find(item => item.status === 'queued');
      if (!row) return;
      const controller = new AbortController();
      this.running++; this.patch(row.id, { status: 'loading', controller });
      const current = () => this.rows.some(item => item.id === row.id && item.generation === row.generation);
      Promise.resolve().then(() => this.request(row, controller.signal)).then(result => {
        if (current()) this.patch(row.id, { ...result, controller: null, tileStatus: result.layer ? 'waiting' : 'unavailable' });
      }).catch(() => {
        if (current()) this.patch(row.id, { status: 'error', controller: null, error: 'Layer generation failed. Check the date range and study area, then retry.' });
      }).finally(() => { this.running--; this.pump(); });
    }
  }
  stop() {
    this.active = false;
    for (const row of this.rows) row.controller?.abort();
    this.rows = this.rows.map(row => ({ ...row, generation: Symbol(), status: ['loading', 'queued'].includes(row.status) ? 'queued' : row.status }));
    // React StrictMode may restart this same store; completed selections stay in memory.
  }
  resume() { this.active = true; this.start(); this.pump(); }
}
