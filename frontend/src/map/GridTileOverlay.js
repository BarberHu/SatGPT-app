export function validPoint(point) {
  // Mapbox projects points behind the camera to Number.MAX_VALUE.
  return Math.abs(point.x) < 2 ** 31 && Math.abs(point.y) < 2 ** 31;
}

export function projectGridPoint(map, [lng, lat], longitude) {
  const world = 360 * Math.round((longitude - lng) / 360);
  return map.project([lng + world, lat]);
}

function projectBoundary(map, bounds, longitudeOffset) {
  const [west, south, east, north] = bounds;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  const projection = map.getProjection?.()?.name ?? 'mercator';
  const steps = projection === 'mercator' && !map.getTerrain?.() ? 1 : 16;
  return corners.flatMap(([lng, lat], index) => {
    const [nextLng, nextLat] = corners[(index + 1) % corners.length];
    return Array.from({ length: steps }, (_, step) => map.project([
      lng + (nextLng - lng) * step / steps + longitudeOffset,
      lat + (nextLat - lat) * step / steps,
    ]));
  });
}

/** Draws vector features from one tile layer through the selected grid's screen mask. */
export class GridTileOverlay {
  constructor(map, { layerId, sourceId, bounds, visible, opacity, canvasClass }) {
    this.map = map;
    this.layerId = layerId;
    this.sourceId = sourceId;
    this.bounds = bounds;
    this.opacity = opacity;
    this.visible = visible;
    this.canvas = document.createElement('canvas');
    this.canvas.className = canvasClass;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext('2d');
    map.getCanvasContainer().appendChild(this.canvas);
    this.invalidate = () => { this.dirty = true; };
    this.onData = event => { if (event.sourceId === this.sourceId) this.invalidate(); };
    this.onRender = () => { if (this.dirty) this.draw(); };
    map.on('move', this.invalidate);
    map.on('resize', this.invalidate);
    map.on('styledata', this.invalidate);
    map.on('sourcedata', this.onData);
    map.on('render', this.onRender);
  }

  get isVisible() { return this.visible; }

  refresh() {
    this.canvas.hidden = !this.isVisible;
    this.invalidate();
    this.map.triggerRepaint?.();
  }

  setVisibility(visible) { this.visible = visible; this.refresh(); }
  setOpacity(opacity) { this.opacity = opacity; this.refresh(); }

  draw() {
    this.dirty = false;
    const ctx = this.context;
    if (!ctx || this.canvas.hidden) return;

    const { width, height, clientWidth, clientHeight } = this.map.getCanvas();
    const cssWidth = clientWidth || width;
    const cssHeight = clientHeight || height;
    if (!cssWidth || !cssHeight) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    ctx.setTransform(width / cssWidth, 0, 0, height / cssHeight, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (!this.map.getLayer(this.layerId)) return;

    const [west, , east] = this.bounds;
    const midpoint = (west + east) / 2;
    const offset = 360 * Math.round((this.map.getCenter().lng - midpoint) / 360);
    const boundary = projectBoundary(this.map, this.bounds, offset);
    if (!boundary.every(validPoint)) return;

    const x = boundary.map(point => point.x);
    const y = boundary.map(point => point.y);
    const left = Math.max(0, Math.floor(Math.min(...x)));
    const top = Math.max(0, Math.floor(Math.min(...y)));
    const right = Math.min(cssWidth, Math.ceil(Math.max(...x)));
    const bottom = Math.min(cssHeight, Math.ceil(Math.max(...y)));
    if (left >= right || top >= bottom) return;

    const features = this.map.queryRenderedFeatures([[left, top], [right, bottom]], { layers: [this.layerId] });
    if (!features.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(boundary[0].x, boundary[0].y);
    for (const point of boundary.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = this.opacity;
    this.paintFeatures(ctx, features, midpoint + offset);
    ctx.restore();
  }

  get image() { return this.canvas.hidden || !this.context ? null : this.canvas; }

  dispose() {
    this.map.off('move', this.invalidate);
    this.map.off('resize', this.invalidate);
    this.map.off('styledata', this.invalidate);
    this.map.off('sourcedata', this.onData);
    this.map.off('render', this.onRender);
    this.canvas.remove();
  }
}
