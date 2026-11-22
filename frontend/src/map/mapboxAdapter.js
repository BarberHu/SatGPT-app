import mapboxgl from 'mapbox-gl';
import { BasicMapPort } from './BasicMapPort';
import { BUILDING_FOOTPRINT_MIN_ZOOM, MAPBOX_STREETS_V8 } from './layerSpec';
import { BuildingTileOverlay } from './BuildingTileOverlay';
import { OsmFeatureInteraction } from './OsmFeatureInteraction';
import { ROAD_CLASSES, ROAD_LEVELS } from './roadLevels';
import { RoadTileOverlay } from './RoadTileOverlay';
import { applyEnglishMapLabels } from '../utils/mapLanguage';
import { publicPath } from '../utils/publicPath.js';

const BASEMAP_LOAD_TIMEOUT = 15000;
// Satellite Streets stores cable-car lines and labels in the same source-layer as roads.
const AERIALWAY_LAYERS = new Set(['aerialway', 'ferry-aerialway-label']);
const LAYER_SUFFIXES = ['', '-fill', '-line', '-point', ':label'];

/** The only module that knows Mapbox GL JS source/layer APIs. */
export class MapboxAdapter {
  constructor(container, { token, style, initialView }) {
    mapboxgl.accessToken = token;
    this.basemap = { style, hideAdministrativeBoundaries: false, hideRoads: false };
    this.styleReady = false;
    this.tileErrors = new Set();
    this.gridOverlays = new Map();
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
      const { hideAdministrativeBoundaries, hideRoads } = this.basemap;
      if (hideAdministrativeBoundaries || hideRoads) {
        for (const layer of this.map.getStyle()?.layers || []) {
          const sourceLayer = layer['source-layer'];
          const administrativeLine = hideAdministrativeBoundaries && layer.type === 'line' && sourceLayer === 'admin';
          const basemapRoad = hideRoads && layer.source === 'composite' && (
            (layer.type === 'symbol' && sourceLayer === 'motorway_junction') ||
            ((layer.type === 'line' || layer.type === 'symbol') && sourceLayer === 'road' && !AERIALWAY_LAYERS.has(layer.id))
          );
          if (administrativeLine || basemapRoad) {
            this.map.setLayoutProperty(layer.id, 'visibility', 'none');
          }
        }
      }
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

  async setBasemap(style, { hideAdministrativeBoundaries = false, hideRoads = false } = {}) {
    if (this.disposed || this.switchingBasemap) throw new Error('The map cannot switch basemaps right now.');
    const previous = this.basemap;
    if (this.styleReady && style === previous.style && hideAdministrativeBoundaries === previous.hideAdministrativeBoundaries
      && hideRoads === previous.hideRoads) return;

    this.switchingBasemap = true;
    try {
      await this.loadBasemapStyle({ style, hideAdministrativeBoundaries, hideRoads });
    } catch (error) {
      if (!this.disposed) await this.loadBasemapStyle(previous);
      throw error;
    } finally {
      this.switchingBasemap = false;
    }
  }

  loadBasemapStyle(basemap) {
    this.basemap = basemap;
    this.osmFeatures.reset();
    this.clearGridOverlays();
    this.tileErrors.clear();
    this.styleReady = false;
    this.basic.styleReady = false;
    this.agentDraw.styleReady = false;

    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timeout);
        this.map.off('style.load', loaded);
        this.map.off('error', failed);
        this.cancelStyleLoad = null;
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish();
      const failed = event => {
        if (!this.styleReady && !event.sourceId) finish(event.error || new Error('Unable to load the basemap.'));
      };
      const timeout = setTimeout(() => finish(new Error('The basemap took too long to load.')), BASEMAP_LOAD_TIMEOUT);
      this.cancelStyleLoad = () => finish(new Error('The map was closed.'));
      this.map.on('style.load', loaded);
      this.map.on('error', failed);
      try { this.map.setStyle(basemap.style, { diff: false }); }
      catch (error) { finish(error); }
    });
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
        const featureColor = ['match', ['get', 'analysis_status'], 'hit', '#c53d24', 'no_data', '#757575', color];
        const geometry = { line: 'LineString', circle: 'Point', fill: 'Polygon' }[layer.renderAs];
        this.map.addLayer({ id: layerId, source: sourceId, type: layer.renderAs,
          filter: ['==', ['geometry-type'], geometry],
          layout: { visibility: layer.visible ? 'visible' : 'none' },
          paint: { ...paint, [layer.renderAs + '-color']: featureColor, [layer.renderAs + '-opacity']: layer.opacity },
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
      }, this.overlayAnchor());
      this.map.addLayer({ id: `${layerId}-line`, source: sourceId, type: 'line',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: layer.visible ? 'visible' : 'none' },
        paint: { 'line-color': '#1f83c7', 'line-opacity': layer.opacity, 'line-width': 2 },
      }, this.overlayAnchor());
      this.map.addLayer({ id: `${layerId}-point`, source: sourceId, type: 'circle',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { visibility: layer.visible ? 'visible' : 'none' },
        paint: { 'circle-color': '#1f83c7', 'circle-opacity': layer.opacity, 'circle-radius': 5 },
      }, this.overlayAnchor());
      return;
    }
    if (layer.kind === 'vector') {
      const streets = layer.url === MAPBOX_STREETS_V8;
      const roads = streets && layer.sourceLayer === 'road';
      const buildings = streets && layer.sourceLayer === 'building' && layer.renderAs === 'fill';
      const clippedRoads = roads && Array.isArray(layer.roadLevels);
      const clippedBuildings = buildings && layer.bounds;
      this.map.addSource(sourceId, {
        type: 'vector',
        ...(streets ? { url: layer.url, bounds: layer.bounds } : { tiles: [publicPath(layer.url)] }),
      });
      const paint = layer.renderAs === 'fill'
        ? { 'fill-color': '#1f83c7', 'fill-opacity': clippedBuildings ? 0 : layer.opacity }
        : layer.renderAs === 'circle'
          ? { 'circle-color': '#1f83c7', 'circle-opacity': layer.opacity, 'circle-radius': 5 }
          : { 'line-color': '#1f83c7', 'line-opacity': clippedRoads ? 0 : layer.opacity, 'line-width': 2 };
      this.map.addLayer({ id: layerId, source: sourceId, 'source-layer': layer.sourceLayer,
        type: layer.renderAs, layout: { visibility: layer.visible ? 'visible' : 'none' }, paint,
        ...(roads && { filter: ['all', ['==', ['geometry-type'], 'LineString'],
          ['in', ['get', 'class'], ['literal', clippedRoads ? ROAD_CLASSES : ROAD_LEVELS[0].classes]]] }),
        ...(buildings && { minzoom: BUILDING_FOOTPRINT_MIN_ZOOM,
          filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['!=', ['get', 'type'], 'building:part'],
            ['!=', ['get', 'underground'], 'true']] }),
      }, this.overlayAnchor());
      const overlayOptions = { layerId, sourceId, bounds: layer.bounds, visible: layer.visible, opacity: layer.opacity };
      if (clippedRoads) {
        this.gridOverlays.set(layer.id, new RoadTileOverlay(this.map, { ...overlayOptions, levels: layer.roadLevels }));
      }
      if (clippedBuildings) {
        this.gridOverlays.set(layer.id, new BuildingTileOverlay(this.map, overlayOptions));
      }
      return;
    }
    this.map.addSource(sourceId, { type: 'raster', tiles: [publicPath(layer.url)], tileSize: 256,
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
    this.gridOverlays.get(id)?.dispose();
    this.gridOverlays.delete(id);
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
    this.gridOverlays.get(id)?.setVisibility(visible);
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
    const overlay = this.gridOverlays.get(id);
    if (overlay) { overlay.setOpacity(opacity); return; }
    const layerId = `satgpt-layer-${id}`;
    if (opacity === 0) this.osmFeatures.hide(layerId);
    for (const suffix of LAYER_SUFFIXES) {
      const key = `${layerId}${suffix}`, layer = this.map.getLayer(key);
      if (layer) this.map.setPaintProperty(key, layer.type === 'symbol' ? 'text-opacity' : `${layer.type}-opacity`, opacity);
    }
  }
  setRoadLevels(id, levels) { this.gridOverlays.get(id)?.setLevels?.(levels); }
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

  captureSnapshot() {
    const base = this.map.getCanvas();
    const visibleOverlays = [...this.gridOverlays.values()].filter(overlay => overlay.image);
    if (!visibleOverlays.length) return base.toDataURL('image/png');
    const composite = document.createElement('canvas');
    composite.width = base.width;
    composite.height = base.height;
    const ctx = composite.getContext('2d');
    if (!ctx) return base.toDataURL('image/png');
    ctx.drawImage(base, 0, 0);
    for (const overlay of visibleOverlays) {
      if (overlay.dirty) overlay.draw();
      ctx.drawImage(overlay.image, 0, 0, base.width, base.height);
    }
    return composite.toDataURL('image/png');
  }
  clearGridOverlays() {
    for (const overlay of this.gridOverlays.values()) overlay.dispose();
    this.gridOverlays.clear();
  }
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
    this.cancelStyleLoad?.();
    this.osmFeatures.dispose();
    this.clearGridOverlays();
    this.basic.dispose();
    this.agentDraw.dispose();
    this.map.removeControl(this.navigation);
    this.map.remove();
  }
}
