/** Minimal stateful Mapbox driver for workspace integration tests, not a second map implementation. */
export class FakeMap {
  static instances = [];
  constructor(options = {}) {
    this.options = options; this.layers = new Map([['place-label', { id: 'place-label', type: 'symbol', source: 'composite', layout: { 'text-field': '{name}' } }]]);
    this.sources = new Map([['composite', {}]]); this.events = []; this.controls = [];
    this.container = options.container || document.createElement('div');
    this.canvas = document.createElement('canvas'); this.container.appendChild(this.canvas);
    this.canvas.toDataURL = vi.fn(() => 'data:image/png;base64,AA==');
    this.view = { center: [100, 15], zoom: 6, bearing: 23, pitch: 32 }; Object.assign(this.view, options.initialView || {});
    this.remove = vi.fn(() => { for (const c of [...this.controls]) this.removeControl(c); this.events = []; });
    this.resize = vi.fn(() => this.fire('resize'));
    this.setStyle = vi.fn(() => { this.layers.clear(); this.sources.clear(); this.styleLoading = true; });
    this.fitBounds = vi.fn(); this.easeTo = vi.fn(); this.flyTo = vi.fn(); this.jumpTo = vi.fn();
    this.setTerrain = vi.fn();
    for (const name of ['boxZoom', 'doubleClickZoom', 'dragPan', 'dragRotate', 'scrollZoom', 'touchZoomRotate', 'keyboard']) {
      let enabled = true; this[name] = { enable: vi.fn(() => { enabled = true; }), disable: vi.fn(() => { enabled = false; }), isEnabled: () => enabled };
    }
    FakeMap.instances.push(this);
  }
  on(event, layer, handler) { if (typeof layer === 'function') { handler = layer; layer = null; } this.events.push({ event, layer, handler }); return this; }
  off(event, layer, handler) { if (typeof layer === 'function') { handler = layer; layer = null; } this.events = this.events.filter(e => e.event !== event || e.layer !== layer || e.handler !== handler); return this; }
  fire(event, payload = {}) { for (const item of [...this.events]) if (item.event === event) item.handler({ type: event, target: this, ...payload }); return this; }
  addControl(control) { this.controls.push(control); const node = control.onAdd?.(this); if (node) this.container.appendChild(node); return this; }
  removeControl(control) { if (this.controls.includes(control)) { control.onRemove?.(this); this.controls.splice(this.controls.indexOf(control), 1); } return this; }
  hasControl(control) { return this.controls.includes(control); }
  getContainer() { return this.container; } getCanvas() { return this.canvas; } getCanvasContainer() { return this.container; }
  getStyle() { return { layers: [...this.layers.values()], sources: Object.fromEntries(this.sources) }; }
  isStyleLoaded() { return !this.styleLoading; } loaded() { return !this.styleLoading; }
  finishStyle() {
    this.styleLoading = false;
    this.fire('data', { dataType: 'style' });
    this.fire('style.load');
  }
  getCenter() { return { lng: this.view.center[0], lat: this.view.center[1] }; }
  getZoom() { return this.view.zoom; } getBearing() { return this.view.bearing; } getPitch() { return this.view.pitch; }
  getBounds() { return { getWest: () => 99, getSouth: () => 14, getEast: () => 101, getNorth: () => 16 }; }
  unproject() { return { distanceTo: () => 100 }; } project() { return { x: 10, y: 10 }; }
  addSource(id, spec) { if (this.sources.has(id)) throw new Error(`Duplicate source ${id}`); this.sources.set(id, { ...spec, setData: vi.fn(), setTiles: vi.fn() }); }
  getSource(id) { return this.sources.get(id); } removeSource(id) { this.sources.delete(id); }
  addLayer(spec) { if (this.layers.has(spec.id)) throw new Error(`Duplicate layer ${spec.id}`); this.layers.set(spec.id, { ...spec, layout: { ...spec.layout }, paint: { ...spec.paint } }); }
  getLayer(id) { return this.layers.get(id); } removeLayer(id) { this.layers.delete(id); } moveLayer() {}
  setLayoutProperty(id, key, value) { const layer = this.layers.get(id); if (layer) layer.layout[key] = value; }
  getLayoutProperty(id, key) { return this.layers.get(id)?.layout?.[key]; }
  setPaintProperty(id, key, value) { const layer = this.layers.get(id); if (layer) layer.paint[key] = value; }
  getPaintProperty(id, key) { return this.layers.get(id)?.paint?.[key]; }
  setFilter() {} queryRenderedFeatures() { return []; }
}
