/** A scoped Mapbox extension port for Basic's draw/grid/terrain algorithms.
 * This is the only escape hatch from the engine-neutral application API. It
 * namespaces all owned sources/layers, gates interaction and view intent, and
 * preserves user visibility independently from the active business group.
 */
const interactive = /^(click|dblclick|mouse|touch|key|contextmenu|draw\.)/;
const aux = id => /^(grid_cell|analysis-aoi|business-layer-scopes|gl-draw-|mapbox-gl-draw)/.test(id);
const handlers = ['boxZoom', 'doubleClickZoom', 'dragPan', 'dragRotate', 'scrollZoom', 'touchZoomRotate', 'keyboard'];

export class BasicMapPort {
  constructor(map) {
    this.map = map; this.active = false; this.epoch = 0; this.disposed = false;
    this.styleReady = map.isStyleLoaded();
    this.layers = new Map(); this.sources = new Set(); this.events = []; this.controls = new Map();
    this.domEvents = []; this.domPorts = new WeakMap(); this.gestures = new Map(); this.terrain = null;
    const methods = new Map();
    this.port = new Proxy(this, { get: (owner, key) => {
      if (handlers.includes(key)) return owner.gesture(key);
      if (key in owner && typeof owner[key] === 'function') {
        if (!methods.has(key)) methods.set(key, owner[key].bind(owner));
        return methods.get(key);
      }
      if (key === 'map') return undefined; // Never expose raw engine through AppContext.
      if (key in owner) return owner[key];
      const value = owner.map[key];
      return typeof value === 'function' ? value.bind(owner.map) : value;
    }});
  }
  physical(id) { return `${aux(id) ? 'satgpt-basic-aux' : 'satgpt-basic'}:${id}`; }
  logical(id) { return typeof id === 'string' ? id.replace(/^satgpt-basic(?:-aux)?:/, '') : id; }
  own(id) { return typeof id === 'string' && /^satgpt-basic(?:-aux)?:/.test(id); }
  foreign(id) { return typeof id === 'string' && id.startsWith('satgpt-') && !this.own(id); }
  source(id) { return this.sources.has(id) ? this.physical(id) : id; }
  isStyleLoaded() { return this.styleReady && !this.disposed; }
  layer(id) { return this.layers.has(id) ? this.physical(id) : id; }
  translateLayer(layer) { return layer ? { ...layer, id: this.logical(layer.id), source: this.logical(layer.source) } : layer; }
  translateFeature(feature) {
    // Mapbox feature geometry/properties can be prototype getters. Spreading the
    // feature alone drops them and breaks both Draw hit testing and fishnet AOIs.
    return { ...feature, type: feature.type, id: feature.id, geometry: feature.geometry, properties: feature.properties,
      source: this.logical(feature.source), sourceLayer: feature.sourceLayer, state: feature.state, layer: this.translateLayer(feature.layer) };
  }
  getLayer(id) { return this.translateLayer(this.map.getLayer(this.layer(id))); }
  getSource(id) { return this.map.getSource(this.source(id)); }
  getStyle() {
    const style = this.map.getStyle() || {};
    return { ...style, layers: (style.layers || []).filter(layer => !this.foreign(layer.id)).map(layer => this.translateLayer(layer)),
      sources: Object.fromEntries(Object.entries(style.sources || {}).filter(([id]) => !this.foreign(id)).map(([id, spec]) => [this.logical(id), spec])) };
  }
  addSource(id, spec) { if (!this.disposed) { this.sources.add(id); this.map.addSource(this.physical(id), spec); } return this.port; }
  removeSource(id) { if (this.sources.has(id)) { this.map.removeSource(this.physical(id)); this.sources.delete(id); } return this.port; }
  addLayer(spec, before) {
    if (this.disposed) return this.port;
    const visible = spec.layout?.visibility || 'visible';
    this.layers.set(spec.id, visible);
    this.map.addLayer({ ...spec, id: this.physical(spec.id), source: typeof spec.source === 'string' ? this.source(spec.source) : spec.source,
      layout: { ...spec.layout, visibility: this.active ? visible : 'none' } }, before ? this.layer(before) : undefined);
    return this.port;
  }
  removeLayer(id) { if (this.layers.has(id)) { this.map.removeLayer(this.physical(id)); this.layers.delete(id); } return this.port; }
  moveLayer(id, before) {
    if (!this.layers.has(id)) return this.port;
    const physical = this.physical(id), target = before ? this.layer(before) : undefined;
    const ids = (this.map.getStyle()?.layers || []).map(layer => layer.id);
    const index = ids.indexOf(physical), next = target ? ids.indexOf(target) : ids.length;
    if (index !== next - 1) this.map.moveLayer(physical, target);
    return this.port;
  }
  setPaintProperty(id, ...args) { if (this.layers.has(id)) this.map.setPaintProperty(this.physical(id), ...args); return this.port; }
  getPaintProperty(id, ...args) { return this.map.getPaintProperty(this.layer(id), ...args); }
  setFilter(id, ...args) { if (this.layers.has(id)) this.map.setFilter(this.physical(id), ...args); return this.port; }
  setLayoutProperty(id, property, value, ...rest) {
    if (!this.layers.has(id)) return this.port;
    if (property === 'visibility') { this.layers.set(id, value); value = this.active ? value : 'none'; }
    this.map.setLayoutProperty(this.physical(id), property, value, ...rest); return this.port;
  }
  getLayoutProperty(id, property) { return property === 'visibility' && this.layers.has(id) ? this.layers.get(id) : this.map.getLayoutProperty(this.layer(id), property); }
  setTerrain(terrain) { this.terrain = terrain; this.map.setTerrain(this.active && terrain ? { ...terrain, source: this.source(terrain.source) } : null); return this.port; }
  queryRenderedFeatures(geometry, options = {}) {
    const result = this.map.queryRenderedFeatures(geometry, { ...options, ...(options.layers ? { layers: options.layers.map(id => this.layer(id)) } : {}) });
    return result.filter(feature => !this.foreign(feature.layer?.id)).map(feature => this.translateFeature(feature));
  }
  bind(event, layer, callback, once = false) {
    if (typeof layer === 'function') { callback = layer; layer = undefined; }
    if (this.events.some(item => item.event === event && item.layer === layer && item.callback === callback)) return this.port;
    const item = { event, layer, physicalLayer: layer ? this.layer(layer) : undefined, callback };
    item.wrapped = payload => {
      if (this.disposed || (!this.active && interactive.test(event)) || this.foreign(payload?.sourceId)) return;
      if (once) this.off(event, ...(layer ? [layer] : []), callback);
      callback({ ...payload, sourceId: this.logical(payload?.sourceId), target: this.port,
        ...(payload?.preventDefault ? { preventDefault: payload.preventDefault.bind(payload) } : {}),
        ...(payload?.features ? { features: payload.features.map(feature => this.translateFeature(feature)) } : {}) });
    };
    this.events.push(item);
    this.map.on(event, ...(layer ? [item.physicalLayer] : []), item.wrapped); return this.port;
  }
  on(event, layer, callback) { return this.bind(event, layer, callback); }
  once(event, layer, callback) { return this.bind(event, layer, callback, true); }
  off(event, layer, callback) {
    if (typeof layer === 'function') { callback = layer; layer = undefined; }
    for (const item of [...this.events]) if (item.event === event && item.layer === layer && item.callback === callback) {
      this.map.off(event, ...(layer ? [item.physicalLayer] : []), item.wrapped);
      this.events.splice(this.events.indexOf(item), 1);
    }
    return this.port;
  }
  dom(node) {
    if (!node || this.domPorts.has(node)) return this.domPorts.get(node) || node;
    const port = new Proxy(node, { get: (target, key) => {
      if (key === 'addEventListener') return (event, listener, options) => {
        const wrapped = e => { if (this.active && !this.disposed) typeof listener === 'function' ? listener(e) : listener.handleEvent(e); };
        this.domEvents.push({ target, event, listener, wrapped, options }); target.addEventListener(event, wrapped, options);
      };
      if (key === 'removeEventListener') return (event, listener) => {
        for (const item of [...this.domEvents]) if (item.target === target && item.event === event && item.listener === listener) {
          target.removeEventListener(event, item.wrapped, item.options); this.domEvents.splice(this.domEvents.indexOf(item), 1);
        }
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    this.domPorts.set(node, port); return port;
  }
  getContainer() { return this.dom(this.map.getContainer()); }
  getCanvas() { return this.dom(this.map.getCanvas()); }
  getCanvasContainer() { return this.dom(this.map.getCanvasContainer()); }
  gesture(name) {
    if (this.gestures.has(name)) return this.gestures.get(name).port;
    const raw = this.map[name]; if (!raw) return raw;
    const state = { enabled: raw.isEnabled?.() !== false };
    state.port = new Proxy(raw, { get: (target, key) => {
      if (key === 'enable' || key === 'disable') return (...args) => { state.enabled = key === 'enable'; if (this.active) target[key](...args); };
      if (key === 'isEnabled') return () => state.enabled;
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }});
    this.gestures.set(name, state); return state.port;
  }
  addControl(control, position) {
    if (this.disposed || this.controls.has(control)) return this.port;
    const wrapped = { getDefaultPosition: () => control.getDefaultPosition?.() || 'top-right',
      onAdd: () => { const node = control.onAdd(this.port); wrapped.node = node; node.style.display = this.active ? '' : 'none'; return node; },
      onRemove: () => control.onRemove(this.port) };
    this.controls.set(control, wrapped); this.map.addControl(wrapped, position); return this.port;
  }
  removeControl(control) { const wrapped = this.controls.get(control); if (wrapped) { this.map.removeControl(wrapped); this.controls.delete(control); } return this.port; }
  activate(active) {
    if (this.disposed || this.active === active) return;
    this.epoch++; this.active = active;
    for (const [id, visible] of this.layers) if (this.map.getLayer(this.physical(id))) this.map.setLayoutProperty(this.physical(id), 'visibility', active ? visible : 'none');
    for (const wrapped of this.controls.values()) if (wrapped.node) wrapped.node.style.display = active ? '' : 'none';
    for (const [name, state] of this.gestures) this.map[name]?.[active && !state.enabled ? 'disable' : 'enable']?.();
    if (this.map.isStyleLoaded()) this.map.setTerrain?.(active && this.terrain ? { ...this.terrain, source: this.source(this.terrain.source) } : null);
    if (!active) this.map.getCanvas().style.cursor = '';
  }
  camera() { const center = this.map.getCenter(); return JSON.stringify([center.lng, center.lat, this.map.getZoom(), this.map.getBearing(), this.map.getPitch()]); }
  createViewLease() { const epoch = this.epoch, camera = this.camera(); return { fitBounds: (...args) => { if (epoch === this.epoch && camera === this.camera()) this.fitBounds(...args); } }; }
  fitBounds(...args) { if (this.active && !this.disposed) this.map.fitBounds(...args); return this.port; }
  flyTo(...args) { if (this.active && !this.disposed) this.map.flyTo(...args); return this.port; }
  easeTo(...args) { if (this.active && !this.disposed) this.map.easeTo(...args); return this.port; }
  jumpTo(...args) { if (this.active && !this.disposed) this.map.jumpTo(...args); return this.port; }
  dispose() {
    if (this.disposed) return;
    for (const control of [...this.controls.keys()]) this.removeControl(control);
    for (const item of [...this.events]) this.off(item.event, ...(item.layer ? [item.layer] : []), item.callback);
    for (const item of this.domEvents) item.target.removeEventListener(item.event, item.wrapped, item.options);
    this.domEvents = []; this.disposed = true;
  }
}
