import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MapScale from './MapScale';
import { MapService } from './mapService';
import { mapOptions } from './config';
import { downloadMapSnapshot } from '../utils/mapSnapshot';

const MapContext = createContext(null);
const VIEW_KEY = 'satgpt:map-view:v1';
export function readWorkspaceView() {
  for (const key of [VIEW_KEY, 'satgpt:harness:map-view:v1']) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (!Array.isArray(value?.center) || value.center.length !== 2 || !value.center.every(Number.isFinite)
        || Math.abs(value.center[0]) > 180 || Math.abs(value.center[1]) > 85
        || !Number.isFinite(value.zoom) || value.zoom < 0 || value.zoom > 24) continue;
      return { center: value.center, zoom: value.zoom,
        bearing: Number.isFinite(value.bearing) ? value.bearing : 0,
        pitch: Number.isFinite(value.pitch) ? Math.max(0, Math.min(85, value.pitch)) : 0 };
    } catch { /* Compatibility read only: do not clear existing storage. */ }
  }
  return undefined;
}
function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch })); }
  catch { /* The live view remains available without storage. */ }
}
export function useSharedMap() {
  const value = useContext(MapContext);
  if (!value) throw new Error('Map workspace must be inside SharedMapProvider');
  return value;
}
export function SharedMapProvider({ mode, children }) {
  const container = useRef(null);
  const surface = useRef(null);
  const instance = useRef(null);
  const currentMode = useRef(mode);
  const epoch = useRef(0);
  const viewport = useRef(null);
  const resize = useRef(() => {});
  const [service, setService] = useState(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  if (currentMode.current !== mode) { currentMode.current = mode; epoch.current++; }
  useLayoutEffect(() => { instance.current?.setMode(mode); resize.current(); }, [mode]);
  useEffect(() => {
    if (!mapOptions.token || !mapOptions.style || !container.current) return undefined;
    let disposed = false, map, stopView, stopReady;
    import('./mapboxAdapter').then(({ MapboxAdapter }) => {
      if (disposed) return;
      const engine = new MapboxAdapter(container.current, { ...mapOptions, initialView: readWorkspaceView() });
      map = new MapService(engine); map.setMode(currentMode.current);
      instance.current = map; setService(map);
      stopView = map.subscribeView(saveView);
      stopReady = map.subscribeReady(() => { setReady(true); resize.current(); });
    }).catch(() => { if (!disposed) setError('Unable to initialize the map. Check the root project configuration.'); });
    return () => {
      disposed = true; stopReady?.(); stopView?.();
      map?.dispose(); instance.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    let frame = null;
    const update = () => {
      frame = null;
      const slot = viewport.current;
      const node = surface.current;
      if (!node) return;
      const box = slot?.getBoundingClientRect();
      const parent = node.parentElement.getBoundingClientRect();
      const shown = Boolean(box?.width > 0 && box?.height > 0);
      node.style.visibility = shown ? 'visible' : 'hidden';
      setVisible(shown);
      if (!shown) return;
      Object.assign(node.style, { left: `${box.left - parent.left}px`, top: `${box.top - parent.top}px`, width: `${box.width}px`, height: `${box.height}px` });
      instance.current?.resize();
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize.current = () => {
      observer?.disconnect();
      if (viewport.current) observer?.observe(viewport.current);
      if (surface.current?.parentElement) observer?.observe(surface.current.parentElement);
      schedule();
    };
    window.addEventListener('resize', schedule);
    resize.current();
    return () => { observer?.disconnect(); window.removeEventListener('resize', schedule); if (frame !== null) cancelAnimationFrame(frame); resize.current = () => {}; };
  }, []);
  const attachViewport = useCallback(node => { viewport.current = node; resize.current(); }, []);
  const captureViewIntent = useCallback((owner, allowConversationChange = false) => {
    const revision = epoch.current;
    const conversation = instance.current?.conversation;
    const camera = () => { const view = instance.current?.getCurrentView(); return JSON.stringify([view?.center, view?.zoom, view?.bearing, view?.pitch]); };
    const initialCamera = camera();
    return { setView: view => {
      if (currentMode.current === owner && revision === epoch.current && camera() === initialCamera
        && (owner !== 'agent' || allowConversationChange || conversation === instance.current?.conversation)) instance.current?.setView(view);
    } };
  }, []);
  const snapshot = useCallback(() => downloadMapSnapshot(instance.current.captureSnapshot()), []);
  const measureGroundDistance = useCallback((...args) => instance.current?.measureGroundDistance(...args), []);
  const subscribeViewport = useCallback(listener => instance.current?.subscribeViewport(listener) || (() => {}), []);
  const value = useMemo(() => ({ container, surface, service, ready, visible, error, mode,
    basicPort: service?.engine.getBasicPort(), configured: Boolean(mapOptions.token && mapOptions.style),
    attachViewport, captureViewIntent, snapshot, measureGroundDistance, subscribeViewport }),
  [service, ready, visible, error, mode, attachViewport, captureViewIntent, snapshot, measureGroundDistance, subscribeViewport]);
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
}
export function SharedMapSurface() {
  const map = useSharedMap();
  return <div ref={map.surface} className="satgpt-map-surface" aria-label="Shared map workspace">
    <div ref={map.container} id="satgpt-map" className="satgpt-map-canvas" aria-label="Map" />
    <div className="satgpt-shared-scale"><MapScale map={map} /></div>
    {!map.configured ? <div className="satgpt-map-status" role="alert">Set the Mapbox public token and basemap style in the root .env file.</div> : null}
    {map.error ? <div className="satgpt-map-status" role="status">{map.error}</div> : null}
  </div>;
}
export function SharedMapViewport({ active = true, className = '', children }) {
  const ref = useRef(null);
  const { attachViewport } = useSharedMap();
  useLayoutEffect(() => {
    if (!active) return undefined;
    attachViewport(ref.current);
    return () => attachViewport(null);
  }, [active, attachViewport]);
  return <div ref={ref} className={`satgpt-map-viewport ${className}`}>{children}</div>;
}
