const UNNAMED = {
  line: 'Unnamed road',
  circle: 'Unnamed point of interest',
  fill: 'Unnamed building',
};
const TAP_TOLERANCE = 8;

function featureContent(properties, renderAs) {
  const content = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = (typeof properties.name === 'string' && properties.name.trim()) || UNNAMED[renderAs];
  content.append(name);
  for (const [label, value] of [
    ['Category', properties.category],
    ['OSM type', properties.osm_type],
    ['OSM ID', properties.osm_id],
  ]) {
    const row = document.createElement('div');
    row.textContent = `${label}: ${value ?? '—'}`;
    content.append(row);
  }
  return content;
}

export class OsmFeatureInteraction {
  constructor(map, createPopup) {
    this.map = map;
    this.createPopup = createPopup;
    this.layers = new Map();
    this.events = {
      click: event => this.open(this.pick(event), event.lngLat),
      mousemove: event => this.hover(this.pick(event)?.layer.id),
      mouseout: () => this.hover(),
      touchstart: event => {
        this.touchStart = !this.suspended && this.layers.size && event.points.length === 1 ? event.point : null;
      },
      touchmove: event => { if (!this.isTap(event)) this.touchStart = null; },
      touchcancel: () => { this.touchStart = null; },
      touchend: event => {
        const tap = this.isTap(event);
        this.touchStart = null;
        if (!tap) return;
        // Draw can suppress the browser's synthesized click, even in read-only mode.
        queueMicrotask(() => {
          if (event.originalEvent.defaultPrevented && this.layers.size && !this.suspended) {
            this.open(this.pick(event), event.lngLat);
          }
        });
      },
    };
    for (const [event, handler] of Object.entries(this.events)) map.on(event, handler);
  }

  isTap(event) {
    const start = this.touchStart;
    return start && event.points.length === 1 &&
      Math.hypot(start.x - event.point.x, start.y - event.point.y) < TAP_TOLERANCE;
  }

  pick(event) {
    if (this.suspended || !this.layers.size) return undefined;
    const layers = [...this.layers].filter(([id, type]) => (
      this.map.getLayer(id) && this.map.getLayoutProperty(id, 'visibility') !== 'none'
      && this.map.getPaintProperty(id, `${type}-opacity`) > 0
    )).map(([id]) => id);
    // Mapbox returns rendered features in paint order, topmost first.
    return layers.length ? this.map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
  }

  hover(id) {
    if (id === this.hovered) return;
    const style = this.map.getCanvas().style;
    if (!this.hovered) this.previousCursor = style.cursor;
    if (id) style.cursor = 'pointer';
    else if (style.cursor === 'pointer') style.cursor = this.previousCursor;
    this.hovered = id;
  }

  open(feature, lngLat) {
    this.close();
    if (!feature) return;
    const id = feature.layer.id;
    const popup = this.createPopup();
    this.popup = { id, popup };
    popup.once('close', () => { if (this.popup?.popup === popup) this.popup = null; });
    popup.setLngLat(lngLat)
      .setDOMContent(featureContent(feature.properties || {}, this.layers.get(id)))
      .addTo(this.map);
  }

  close() { this.popup?.popup.remove(); }

  hide(id) {
    if (this.hovered === id) this.hover();
    if (this.popup?.id === id) this.close();
  }

  remove(id) {
    if (this.layers.delete(id)) this.hide(id);
  }

  setSuspended(suspended) {
    this.suspended = suspended;
    if (suspended) this.clearInteraction();
  }

  clearInteraction() {
    this.touchStart = null;
    this.close();
    this.hover();
  }

  reset() {
    this.clearInteraction();
    this.layers.clear();
  }

  dispose() {
    this.reset();
    for (const [event, handler] of Object.entries(this.events)) this.map.off(event, handler);
  }
}
