import { normalizeLayer } from './layerSpec';

/** Map-facing application port. The agent and GEE worker never receive an engine instance. */
export class MapService {
  constructor(engine) {
    this.engine = engine;
    this.layers = new Map();
    this.listeners = new Set();
    this.unbind = engine.onStyleReady?.(() => this.rehydrate());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.listLayers();
    for (const listener of this.listeners) listener(snapshot);
  }

  getCurrentView() { return this.engine.getView(); }
  setView(view) { this.engine.setView(view); }
  captureSnapshot() { return this.engine.captureSnapshot(); }
  resize() { this.engine.resize?.(); }
  subscribeView(listener) { return this.engine.onViewChange?.(() => listener(this.getCurrentView())) || (() => {}); }
  subscribeViewport(listener) { return this.engine.onViewportChange?.(listener) || (() => {}); }
  measureGroundDistance(start, end) { return this.engine.measureGroundDistance?.(start, end) ?? null; }
  listLayers() { return [...this.layers.values()]; }

  addLayer(input) {
    const layer = normalizeLayer(input);
    if (this.layers.has(layer.id)) this.engine.removeLayer(layer.id);
    this.layers.set(layer.id, layer);
    this.engine.addLayer(layer);
    this.notify();
    return layer;
  }

  removeLayer(id) {
    if (!this.layers.delete(id)) return false;
    this.engine.removeLayer(id);
    this.notify();
    return true;
  }

  setVisibility(id, visible) {
    const layer = this.layers.get(id);
    if (!layer) return false;
    const next = { ...layer, visible: Boolean(visible) };
    this.layers.set(id, next);
    this.engine.setVisibility(id, next.visible);
    this.notify();
    return true;
  }

  rehydrate() {
    for (const layer of this.layers.values()) this.engine.addLayer(layer);
  }

  dispose() {
    this.unbind?.();
    this.listeners.clear();
    this.engine.dispose();
  }
}
