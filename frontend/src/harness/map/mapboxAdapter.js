import mapboxgl from 'mapbox-gl';

/** The only module that knows Mapbox GL JS source/layer APIs. */
export class MapboxAdapter {
  constructor(container, { token, style, initialView }) {
    mapboxgl.accessToken = token;
    this.styleReady = false;
    this.map = new mapboxgl.Map({
      container, style, center: initialView?.center || [102, 16.5], zoom: initialView?.zoom ?? 5,
      preserveDrawingBuffer: true,
    });
    this.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  }

  onStyleReady(callback) {
    const handleReady = () => {
      this.styleReady = true;
      callback();
    };
    this.map.on('style.load', handleReady);
    return () => this.map.off('style.load', handleReady);
  }

  onViewChange(callback) {
    this.map.on('moveend', callback);
    return () => this.map.off('moveend', callback);
  }

  onViewportChange(callback) {
    this.map.on('move', callback);
    this.map.on('resize', callback);
    return () => { this.map.off('move', callback); this.map.off('resize', callback); };
  }

  measureGroundDistance(start, end) {
    return this.map.unproject(start).distanceTo(this.map.unproject(end));
  }

  getView() {
    const center = this.map.getCenter();
    const bounds = this.map.getBounds();
    return {
      center: [center.lng, center.lat], zoom: this.map.getZoom(),
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    };
  }

  setView({ center, zoom, bounds }) {
    if (bounds) this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]]);
    else this.map.easeTo({ center, zoom });
  }

  addLayer(layer) {
    if (!this.styleReady) return;
    const sourceId = `satgpt-source-${layer.id}`;
    const layerId = `satgpt-layer-${layer.id}`;
    this.removeLayer(layer.id);
    if (layer.kind === 'geojson') {
      this.map.addSource(sourceId, { type: 'geojson', data: layer.data });
      this.map.addLayer({ id: `${layerId}-fill`, source: sourceId, type: 'fill',
        filter: ['==', ['geometry-type'], 'Polygon'],
        layout: { visibility: layer.visible ? 'visible' : 'none' },
        paint: { 'fill-color': '#1f83c7', 'fill-opacity': layer.opacity },
      });
      this.map.addLayer({ id: `${layerId}-line`, source: sourceId, type: 'line',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: layer.visible ? 'visible' : 'none' },
        paint: { 'line-color': '#1f83c7', 'line-opacity': layer.opacity, 'line-width': 2 },
      });
      this.map.addLayer({ id: `${layerId}-point`, source: sourceId, type: 'circle',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { visibility: layer.visible ? 'visible' : 'none' },
        paint: { 'circle-color': '#1f83c7', 'circle-opacity': layer.opacity, 'circle-radius': 5 },
      });
      return;
    }
    if (layer.kind === 'vector') {
      this.map.addSource(sourceId, { type: 'vector', tiles: [layer.url] });
      const paint = layer.renderAs === 'fill'
        ? { 'fill-color': '#1f83c7', 'fill-opacity': layer.opacity }
        : layer.renderAs === 'circle'
          ? { 'circle-color': '#1f83c7', 'circle-opacity': layer.opacity, 'circle-radius': 5 }
          : { 'line-color': '#1f83c7', 'line-opacity': layer.opacity, 'line-width': 2 };
      this.map.addLayer({ id: layerId, source: sourceId, 'source-layer': layer.sourceLayer,
        type: layer.renderAs, layout: { visibility: layer.visible ? 'visible' : 'none' }, paint,
      });
      return;
    }
    this.map.addSource(sourceId, { type: 'raster', tiles: [layer.url], tileSize: 256 });
    this.map.addLayer({ id: layerId, source: sourceId, type: 'raster',
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    });
  }

  removeLayer(id) {
    if (!this.styleReady) return;
    const layerId = `satgpt-layer-${id}`;
    const sourceId = `satgpt-source-${id}`;
    for (const suffix of ['-point', '-line', '-fill', '']) {
      const current = `${layerId}${suffix}`;
      if (this.map.getLayer(current)) this.map.removeLayer(current);
    }
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  setVisibility(id, visible) {
    const layerId = `satgpt-layer-${id}`;
    for (const suffix of ['', '-fill', '-line', '-point']) {
      const current = `${layerId}${suffix}`;
      if (this.map.getLayer(current)) {
        this.map.setLayoutProperty(current, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  captureSnapshot() { return this.map.getCanvas().toDataURL('image/png'); }
  resize() { this.map.resize(); }
  dispose() { this.map.remove(); }
}
