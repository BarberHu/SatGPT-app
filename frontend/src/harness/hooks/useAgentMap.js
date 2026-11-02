import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedMap } from '../../map/SharedMapContext';
import { latestLayerBounds, messageLayerBounds } from '../map/viewState';
import { messageLayerPresentation } from '../../map/layerPresentation';

const choicesKey = id => `satgpt:harness:layers:${id}`;
export function readLayerChoices(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(choicesKey(id)));
    return { visibility: saved?.visibility || {}, removed: new Set(saved?.removed || []) };
  } catch { return { visibility: {}, removed: new Set() }; }
}

/** Agent results are a session-scoped projection onto the one shared map. */
export function useAgentMap(conversationId, messages) {
  const shared = useSharedMap();
  const current = useRef(null);
  const choices = useRef({ id: null, ...readLayerChoices(null) });
  const focusIntent = useRef(null);
  const [layers, setLayers] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!shared.service || !shared.ready || !conversationId) return undefined;
    const scope = shared.service.scope(`agent:${conversationId}`);
    current.current = scope;
    shared.service.selectConversation(conversationId);
    choices.current = { id: conversationId, ...readLayerChoices(conversationId) };
    setLayers(scope.listLayers());
    const unsubscribe = scope.subscribe(setLayers);
    return () => { unsubscribe(); if (current.current === scope) current.current = null; };
  }, [shared.service, shared.ready, conversationId]);
  useEffect(() => {
    const map = current.current;
    if (!map || choices.current.id !== conversationId) return;
    for (const layer of map.listLayers()) if (choices.current.removed.has(layer.id)) map.removeLayer(layer.id);
    for (const message of messages) {
      (message.layers || []).forEach((layer, index) => {
        const id = `${message.job_id}-${index}`;
        if (choices.current.removed.has(id)) return;
        try {
          if (!map.listLayers().some(item => item.id === id)) map.addLayer({ ...messageLayerPresentation(layer, message),
            id, kind: 'gee', bounds: messageLayerBounds(message, layer), visible: choices.current.visibility[id] ?? layer.visible });
        } catch (cause) { setError(`Unable to load layer: ${cause.message}`); }
      });
    }
    // Only an explicit history action may restore a result extent. Mode switches
    // and arriving task results never claim camera ownership.
    if (focusIntent.current) {
      const bounds = latestLayerBounds(messages);
      if (bounds) focusIntent.current.setView({ bounds });
      focusIntent.current = null;
    }
  }, [shared.service, shared.ready, conversationId, messages]);
  const prepareConversationChange = () => { focusIntent.current = shared.captureViewIntent('agent', true); };
  const persist = () => {
    try { localStorage.setItem(choicesKey(choices.current.id), JSON.stringify({
      visibility: choices.current.visibility, removed: [...choices.current.removed],
    })); } catch { /* Map remains usable without browser storage. */ }
  };
  const toggleLayer = (id, visible) => {
    current.current?.setVisibility(id, visible); choices.current.visibility[id] = visible; persist();
  };
  const removeLayer = id => { current.current?.removeLayer(id); choices.current.removed.add(id); persist(); };
  const focusLayer = layer => { if (layer.bounds) shared.captureViewIntent('agent').setView({ bounds: layer.bounds }); };
  const bounds = useCallback(() => shared.service?.getCurrentView().bounds, [shared.service]);
  return { ready: shared.ready, layers, error, configured: shared.configured,
    toggleLayer, removeLayer, focusLayer, bounds, prepareConversationChange };
}
