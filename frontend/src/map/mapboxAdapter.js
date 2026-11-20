import mapboxgl from 'mapbox-gl';
import { BasicMapPort } from './BasicMapPort';
import { OsmFeatureInteraction } from './OsmFeatureInteraction';
import { applyEnglishMapLabels } from '../utils/mapLanguage';
import { publicPath } from '../utils/publicPath.js';

const LAYER_SUFFIXES = ['', '-fill', '-line', '-point', ':label'];

/** The only module that knows Mapbox GL JS source/layer APIs. */
export class MapboxAdapter {
  constructor(container, { token, style, initialView }) {
    mapboxgl.accessToken = token;
    this.styleReady = false;
    this.tileErrors = new Set();
    this.map = new mapboxgl.Map({
      container, style, center: initialView?.center || [102, 16.5], zoom: initialView?.zoom ?? 5,
      bearing: initialView?.bearing ?? 0, pitch: initialView?.pitch ?? 0,
      preserveDrawingBuffer: true,
    });
    this.map.getCanvas().dataset.mapInstance = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    this.navigation = new mapboxgl.NavigationControl();
    this.map.addControl(this.navigation, 'top-right');
    this.basic = new BasicMapPort(this.map);
    this.agentDraw = new BasicMapPort(this.map, 'satgpt-agent-aoi');
    this.osmFeatures = new OsmFeatureInteraction(this.map, () => new mapboxgl.Popup({
      className: 'satgpt-osm-popup', closeOnClick: false, offset: 8,
    }));
    this.basic.activate(true);
  }

  onStyleReady(callback) {
    const handleReady = () => {
      applyEnglishMapLabels(this.map);
      this.styleReady = true;
      this.basic.styleReady = true;
      this.agentDraw.styleReady = true;
      callback();
    };
    this.map.on('style.load', handleReady);
    const labels = () => applyEnglishMapLabels(this.map);
    this.map.on('styledata', labels);
    if (this.map.isStyleLoaded()) handleReady();
    return () => { this.map.off('style.load', handleReady); this.map.off('styledata', labels); };
  }

  onViewChange(callback) {
    this.map.on('moveend', callback);
    return () => this.map.off('moveend', callback);
  }
  onError(callback) { this.map.on('error', callback); return () => this.map.off('error', callback); }

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
      bearing: this.map.getBearing(), pitch: this.map.getPitch(),
      bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    };
  }

  setView({ center, zoom, bounds, bearing, pitch }) {
    if (bounds) this.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]]);
    else this.map.easeTo({ center, zoom, bearing, pitch });
  }

  addLayer(layer) {
    if (!this.styleReady) return;
    const sourceId = `satgpt-source-${layer.id}`;
    const layerId = `satgpt-layer-${layer.id}`;
    this.removeLayer(layer.id);
    if (layer.kind === 'geojson') {
      this.map.addSource(sourceId, { type: 'geojson', data: layer.dataUrl ? new URL(publicPath(layer.dataUrl), window.location.origin).href : layer.data,
        ...(layer.dataUrl && { attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>' }) });
      if (layer.dataUrl) {
        const style = {
          line: { color: '#1685a9', 'line-width': 2.5 },
          circle: { color: '#a9387e', 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
          fill: { color: '#d58620', 'fill-outline-color': '#9c5d12' },
        }[layer.renderAs];
        const { color, ...paint } = style;
        const geometry = { line: 'LineString', circle: 'Point', fill: 'Polygon' }[layer.renderAs];
        this.map.addLayer({ id: layerId, source: sourceId, type: layer.renderAs,
          filter: ['==', ['geometry-type'], geometry],
          layout: { visibility: layer.visible ? 'visible' : 'none' },
          paint: { ...paint, [layer.renderAs + '-color']: color, [layer.renderAs + '-opacity']: layer.opacity },
        }, this.overlayAnchor());
        if (layer.osmInteractive) {
          this.osmFeatures.layers.set(layerId, layer.renderAs);
          const road = layer.renderAs === 'line';
          this.map.addLayer({
            id: `${layerId}:label`, source: sourceId, type: 'symbol', minzoom: road ? 14 : 16,
            filter: ['all', ['==', ['geometry-type'], geometry], ['!=', ['string', ['get', 'name'], ''], '']],
            layout: {
              visibility: layer.visible ? 'visible' : 'none',
              'symbol-placement': road ? 'line' : 'point',
              'text-field': ['get', 'name'],
              'text-size': 12,
              'text-allow-overlap': false,
              'text-ignore-placement': false,
              ...(!road && { 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.65 }),
            },
            paint: { 'text-color': '#162737', 'text-halo-color': '#fff', 'text-halo-width': 1.4, 'text-opacity': layer.opacity },
          }, this.overlayAnchor());
        }
        return;
      }
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
    this.map.addSource(sourceId, { type: 'raster', tiles: [layer.url], tileSize: 256,
      ...(layer.bounds ? { bounds: layer.bounds } : {}) });
    this.map.addLayer({ id: layerId, source: sourceId, type: 'raster',
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity },
    }, this.overlayAnchor());
  }

  overlayAnchor() {
    return this.map.getStyle()?.layers?.find(layer => /-aux:(analysis-aoi|gl-draw-)/.test(layer.id))?.id;
  }

  removeLayer(id) {
    this.tileErrors.delete(id);
    const layerId = `satgpt-layer-${id}`;
    this.osmFeatures.remove(layerId);
    if (!this.styleReady) return;
    const sourceId = `satgpt-source-${id}`;
    for (const suffix of LAYER_SUFFIXES) {
      const current = `${layerId}${suffix}`;
      if (this.map.getLayer(current)) this.map.removeLayer(current);
    }
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  }

  setVisibility(id, visible) {
    const layerId = `satgpt-layer-${id}`;
    if (!visible) this.osmFeatures.hide(layerId);
    for (const suffix of LAYER_SUFFIXES) {
      const current = `${layerId}${suffix}`;
      if (this.map.getLayer(current)) {
        this.map.setLayoutProperty(current, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  setOpacity(id, opacity) {
    const layerId = `satgpt-layer-${id}`;
    if (opacity === 0) this.osmFeatures.hide(layerId);
    for (const suffix of LAYER_SUFFIXES) {
      const key = `${layerId}${suffix}`, layer = this.map.getLayer(key);
      if (layer) this.map.setPaintProperty(key, layer.type === 'symbol' ? 'text-opacity' : `${layer.type}-opacity`, opacity);
    }
  }
  moveLayer(id) {
    for (const suffix of LAYER_SUFFIXES) {
      const key = `satgpt-layer-${id}${suffix}`;
      if (this.map.getLayer(key)) this.map.moveLayer(key, this.overlayAnchor());
    }
  }
  onTileStatus(listener) {
    const handle = event => {
      if (!event.sourceId?.startsWith('satgpt-source-scope--')) return;
      const id = event.sourceId.slice('satgpt-source-'.length);
      if (event.type === 'error') this.tileErrors.add(id);
      listener({ id, statusCode: event.error?.status || event.error?.statusCode || null, state: this.tileErrors.has(id) ? 'error'
        : event.isSourceLoaded ? 'ready' : 'loading' });
    };
    for (const name of ['sourcedataloading', 'sourcedata', 'error']) this.map.on(name, handle);
    return () => { for (const name of ['sourcedataloading', 'sourcedata', 'error']) this.map.off(name, handle); };
  }

  captureSnapshot() { return this.map.getCanvas().toDataURL('image/png'); }
  resize() { this.map.resize(); }
  getBasicPort() { return this.basic.port; }
  getAgentDrawPort() { return this.agentDraw.port; }
  setOsmPickingSuspended(suspended) { this.osmFeatures.setSuspended(suspended); }
  setBasicActive(active) {
    // Suspend the previous owner before enabling the next one's gestures.
    if (active) { this.agentDraw.activate(false); this.basic.activate(true); }
    else { this.basic.activate(false); this.agentDraw.activate(true); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.osmFeatures.dispose();
    this.basic.dispose();
    this.agentDraw.dispose();
    this.map.removeControl(this.navigation);
    this.map.remove();
  }
}
