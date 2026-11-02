import { useCallback, useEffect, useRef, useState } from 'react';
import { MapService } from '../map/mapService';
import { mapOptions } from '../map/config';
import { latestLayerBounds, messageLayerBounds, readAgentView, saveAgentView } from '../map/viewState';

const choicesKey = id => `satgpt:harness:layers:${id}`;
export function readLayerChoices(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(choicesKey(id)));
    return { visibility: saved?.visibility || {}, removed: new Set(saved?.removed || []) };
  } catch { return { visibility: {}, removed: new Set() }; }
}

export function useAgentMap(conversationId, messages) {
  const container = useRef(null);
  const service = useRef(null);
  const choices = useRef({ id: null, ...readLayerChoices(null) });
  const restoredView = useRef(false);
  const [layers, setLayers] = useState([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!container.current || !mapOptions.token || !mapOptions.style) return undefined;
    let disposed = false;
    let unsubscribe;
    let unsubscribeView;
    const initialView = readAgentView();
    restoredView.current = Boolean(initialView);
    let resize;
    import('../map/mapboxAdapter').then(({ MapboxAdapter }) => {
      if (disposed) return;
      const map = new MapService(new MapboxAdapter(container.current, { ...mapOptions, initialView }));
      service.current = map;
      unsubscribe = map.subscribe(setLayers);
      unsubscribeView = map.subscribeView(saveAgentView);
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => map.resize());
        resize.observe(container.current);
      }
      setReady(true);
    }).catch(cause => { if (!disposed) setError(cause.message); });
    return () => {
      disposed = true;
      resize?.disconnect();
      unsubscribe?.(); unsubscribeView?.();
      service.current?.dispose(); service.current = null;
    };
  }, []);

  useEffect(() => {
    const map = service.current;
    if (!map || !conversationId) return;
    if (choices.current.id !== conversationId) {
      const switching = Boolean(choices.current.id);
      for (const layer of map.listLayers()) map.removeLayer(layer.id);
      choices.current = { id: conversationId, ...readLayerChoices(conversationId) };
      if (switching) restoredView.current = false;
    }
    for (const message of messages) {
      (message.layers || []).forEach((layer, index) => {
        const id = `${message.job_id}-${index}`;
        if (!choices.current.removed.has(id) && !map.listLayers().some(item => item.id === id)) {
          try { map.addLayer({ ...layer, id, kind: 'gee', bounds: messageLayerBounds(message, layer),
            visible: choices.current.visibility[id] ?? layer.visible }); }
          catch (cause) { setError(`图层无法加载：${cause.message}`); }
        }
      });
    }
    if (!restoredView.current) {
      const bounds = latestLayerBounds(messages);
      if (bounds) { map.setView({ bounds }); restoredView.current = true; }
    }
  }, [ready, conversationId, messages]);

  const persist = () => {
    try { localStorage.setItem(choicesKey(choices.current.id), JSON.stringify({
      visibility: choices.current.visibility, removed: [...choices.current.removed],
    })); } catch { /* map remains usable without browser storage */ }
  };
  const toggleLayer = (id, visible) => {
    service.current?.setVisibility(id, visible);
    choices.current.visibility[id] = visible;
    persist();
  };
  const removeLayer = id => {
    service.current?.removeLayer(id);
    choices.current.removed.add(id);
    persist();
  };
  const focusLayer = layer => { if (layer.bounds) service.current?.setView({ bounds: layer.bounds }); };
  const bounds = useCallback(() => service.current?.getCurrentView().bounds, []);
  const snapshot = () => {
    try {
      const link = document.createElement('a');
      link.href = service.current.captureSnapshot(); link.download = 'satgpt-map.png'; link.click();
    } catch (cause) { setError(`截图失败：${cause.message}`); }
  };
  return { container, ready, layers, error, configured: Boolean(mapOptions.token && mapOptions.style),
    toggleLayer, removeLayer, focusLayer, bounds, snapshot };
}
