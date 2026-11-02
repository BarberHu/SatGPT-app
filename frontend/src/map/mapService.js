import { normalizeLayer } from './layerSpec';

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
  captureSnapshot() { return this.engine.captureSnapshot(); }
  resize() { if (!this.disposed) this.engine.resize?.(); }
  subscribeView(listener) { return this.engine.onViewChange?.(() => listener(this.getCurrentView())) || (() => {}); }
  subscribeViewport(listener) { return this.engine.onViewportChange?.(listener) || (() => {}); }
  measureGroundDistance(start, end) { return this.engine.measureGroundDistance?.(start, end) ?? null; }
  physical(group, id) { return `scope--${encodeURIComponent(group)}--${id}`; }
  enabled(group) { return group === 'default' || (this.mode === 'agent' && group === `agent:${this.conversation}`); }
  render(row) { return { ...row.layer, id: this.physical(row.group, row.layer.id), visible: row.layer.visible && this.enabled(row.group) }; }
  listLayers(group = 'default') { return [...this.layers.values()].filter(row => row.group === group).map(row => row.layer); }
  addLayer(input, group = 'default') {
    const layer = normalizeLayer(input); const key = this.physical(group, layer.id);
    if (this.layers.has(key)) this.engine.removeLayer(key);
    const row = { group, layer }; this.layers.set(key, row); this.engine.addLayer(this.render(row)); this.notify(); return layer;
  }
  removeLayer(id, group = 'default') {
    const key = this.physical(group, id); if (!this.layers.delete(key)) return false;
    this.engine.removeLayer(key); this.notify(); return true;
  }
  setVisibility(id, visible, group = 'default') {
    const row = this.layers.get(this.physical(group, id)); if (!row) return false;
    row.layer = { ...row.layer, visible: Boolean(visible) };
    this.engine.setVisibility(this.physical(group, id), row.layer.visible && this.enabled(group)); this.notify(); return true;
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
