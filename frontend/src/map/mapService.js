import { normalizeLayer } from './layerSpec';
import { normalizeRoadLevels } from './roadLevels';

/** One engine, with explicit mode/session groups and independently saved visibility. */
export class MapService {
  constructor(engine) {
    this.engine = engine; this.layers = new Map(); this.listeners = new Set();
    this.mode = 'basic'; this.conversation = null; this.scopes = new Map(); this.disposed = false;
    this.readyListeners = new Set();
    this.unbind = engine.onStyleReady?.(() => { this.ready = true; this.rehydrate(); for (const listener of this.readyListeners) listener(); });
  }
  subscribeReady(listener) { this.readyListeners.add(listener); if (this.ready) listener(); return () => this.readyListeners.delete(listener); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() { for (const listener of this.listeners) listener(this.listLayers()); }
  getCurrentView() { return this.engine.getView(); }
  setView(view) { this.engine.setView(view); }
  setBasemap(style, options) { return this.engine.setBasemap(style, options); }
  captureSnapshot() { return this.engine.captureSnapshot(); }
  resize() { if (!this.disposed) this.engine.resize?.(); }
  subscribeView(listener) { return this.engine.onViewChange?.(() => listener(this.getCurrentView())) || (() => {}); }
  subscribeViewport(listener) { return this.engine.onViewportChange?.(listener) || (() => {}); }
  measureGroundDistance(start, end) { return this.engine.measureGroundDistance?.(start, end) ?? null; }
  physical(group, id) { return `scope--${encodeURIComponent(group)}--${id}`; }
  enabled(group) { return group === 'default' || (this.mode === 'basic' && group === 'basic:presets') || (this.mode === 'agent' && group === `agent:${this.conversation}`); }
  render(row) {
    return { ...row.layer, id: this.physical(row.group, row.layer.id), visible: row.layer.visible && this.enabled(row.group),
      ...(row.layer.dataUrl && row.group.startsWith('agent:') && { osmInteractive: true }) };
  }
  setOsmPickingSuspended(suspended) { this.engine.setOsmPickingSuspended?.(suspended); }
  listLayers(group = 'default') { return [...this.layers.values()].filter(row => row.group === group).map(row => row.layer); }
  addLayer(input, group = 'default') {
    const layer = normalizeLayer(input); const key = this.physical(group, layer.id);
    const row = { group, layer }; this.layers.set(key, row); this.engine.addLayer(this.render(row)); this.notify(); return layer;
  }
  removeLayer(id, group = 'default') {
    const key = this.physical(group, id); if (!this.layers.delete(key)) return false;
    this.engine.removeLayer(key); this.notify(); return true;
  }
  replaceLayer(id, input, group = 'default') {
    const key = this.physical(group, id), previous = this.layers.get(key);
    if (!previous) return false; // Removed during a reload: never resurrect it.
    const version = Number(input.reload_version ?? input.reloadVersion) || 0;
    if (version < previous.layer.reloadVersion) return false;
    const layer = normalizeLayer({ ...input, id, visible: previous.layer.visible, opacity: previous.layer.opacity });
    const row = { group, layer }; this.layers.set(key, row);
    this.engine.addLayer(this.render(row));
    // Replacing a source must preserve the group's existing paint order.
    for (const item of this.layers.values()) if (item.group === group) this.engine.moveLayer?.(this.physical(group, item.layer.id));
    this.notify(); return layer;
  }
  setVisibility(id, visible, group = 'default') {
    const row = this.layers.get(this.physical(group, id)); if (!row) return false;
    if (row.layer.visible === Boolean(visible)) return true;
    row.layer = { ...row.layer, visible: Boolean(visible) };
    this.engine.setVisibility(this.physical(group, id), row.layer.visible && this.enabled(group)); this.notify(); return true;
  }
  setOpacity(id, opacity, group = 'default') {
    const row = this.layers.get(this.physical(group, id));
    if (!row || !Number.isFinite(opacity)) return false;
    if (row.layer.opacity === Math.max(0, Math.min(1, opacity))) return true;
    row.layer = { ...row.layer, opacity: Math.max(0, Math.min(1, opacity)) };
    this.engine.setOpacity?.(this.physical(group, id), row.layer.opacity); this.notify(); return true;
  }
  setRoadLevels(id, levels, group = 'default') {
    const key = this.physical(group, id);
    const row = this.layers.get(key);
    if (!row?.layer.roadLevels) return false;
    const next = normalizeRoadLevels(levels);
    if (next.length === row.layer.roadLevels.length && next.every((level, index) => level === row.layer.roadLevels[index])) return true;
    row.layer = { ...row.layer, roadLevels: next };
    this.engine.setRoadLevels?.(key, next); this.notify(); return true;
  }
  setOrder(ids, group = 'default') {
    // The public order is top first; engines paint bottom first.
    const rows = [...this.layers.values()].filter(row => row.group === group);
    const ordered = [...ids].reverse().map(id => rows.find(row => row.layer.id === id)).filter(Boolean);
    for (const row of rows) if (!ordered.includes(row)) ordered.unshift(row);
    if (rows.every((row, index) => row === ordered[index])) return;
    for (const row of rows) this.layers.delete(this.physical(group, row.layer.id));
    for (const row of ordered) {
      this.layers.set(this.physical(group, row.layer.id), row);
      this.engine.moveLayer?.(this.physical(group, row.layer.id));
    }
  }
  subscribeTileStatus(listener, group) {
    return this.engine.onTileStatus?.(event => {
      const row = [...this.layers.values()].find(row => row.group === group && this.physical(group, row.layer.id) === event.id);
      if (row) listener({ ...event, id: row.layer.id, url: row.layer.url });
    }) || (() => {});
  }
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode; this.engine.setBasicActive?.(mode === 'basic'); this.syncGroups();
  }
  selectConversation(id) { if (this.conversation !== id) { this.conversation = id; this.syncGroups(); } }
  syncGroups() { for (const row of this.layers.values()) this.engine.setVisibility(this.physical(row.group, row.layer.id), row.layer.visible && this.enabled(row.group)); }
  scope(group) {
    if (this.scopes.has(group)) return this.scopes.get(group);
    const scoped = {
      listLayers: () => this.listLayers(group), addLayer: input => this.addLayer(input, group),
      removeLayer: id => this.removeLayer(id, group), setVisibility: (id, visible) => this.setVisibility(id, visible, group),
      replaceLayer: (id, input) => this.replaceLayer(id, input, group),
      setOpacity: (id, opacity) => this.setOpacity(id, opacity, group), setOrder: ids => this.setOrder(ids, group),
      setRoadLevels: (id, levels) => this.setRoadLevels(id, levels, group),
      subscribeTileStatus: listener => this.subscribeTileStatus(listener, group),
      subscribe: listener => this.subscribe(() => listener(this.listLayers(group))),
      getCurrentView: () => this.getCurrentView(), setView: view => { if (this.enabled(group)) this.setView(view); },
      captureSnapshot: () => this.captureSnapshot(), measureGroundDistance: (...args) => this.measureGroundDistance(...args),
    };
    this.scopes.set(group, scoped); return scoped;
  }
  rehydrate() { for (const row of this.layers.values()) this.engine.addLayer(this.render(row)); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.unbind?.(); this.readyListeners.clear(); this.listeners.clear(); this.scopes.clear(); this.layers.clear(); this.engine.dispose();
  }
}
