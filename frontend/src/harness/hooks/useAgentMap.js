import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedMap } from '../../map/SharedMapContext';
import { latestLayerBounds, messageLayerBounds } from '../map/viewState';
import { messageLayerPresentation, previewUrl } from '../../map/layerPresentation';
import { chatApi } from '../chatApi';

const choicesKey = id => `satgpt:harness:layers:${id}`;
const thumbnailKey = (cid, id, version) => `${cid}:${id}:${version}`;
function readLayerChoices(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(choicesKey(id)));
    return { visibility: saved?.visibility || {}, removed: new Set(saved?.removed || []) };
  } catch { return { visibility: {}, removed: new Set() }; }
}

/** Agent results are a session-scoped projection onto the one shared map. */
export function useAgentMap(conversationId, messages) {
  const shared = useSharedMap();
  const current = useRef(null);
  const choices = useRef({ id: null, visibility: {}, removed: new Set() });
  const focusIntent = useRef(null);
  const [layers, setLayers] = useState([]);
  const [error, setError] = useState('');
  const [layerStatus, setLayerStatus] = useState({});
  const [thumbnails, setThumbnails] = useState({});
  const reloading = useRef(new Set());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!shared.service || !shared.ready) return undefined;
    shared.service.selectConversation(conversationId);
    if (!conversationId) {
      focusIntent.current = null;
      setLayers([]);
      return undefined;
    }
    const scope = shared.service.scope(`agent:${conversationId}`);
    current.current = scope;
    choices.current = { id: conversationId, ...readLayerChoices(conversationId) };
    setLayers(scope.listLayers());
    const unsubscribe = scope.subscribe(setLayers);
    const stopTiles = scope.subscribeTileStatus(event => {
      if (!alive.current) return;
      const key = `${conversationId}:${event.id}`;
      setLayerStatus(previous => ({ ...previous, [key]: { ...previous[key], tiles: event.state,
        statusCode: event.statusCode || previous[key]?.statusCode || null } }));
    });
    return () => { unsubscribe(); stopTiles(); if (current.current === scope) current.current = null; };
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
          const existing = map.getLayer(id);
          const needsReplacement = existing && ((layer.reload_version || 0) > existing.reloadVersion || (!existing.code && layer.code));
          if (existing && !needsReplacement) return;
          const spec = { ...messageLayerPresentation(layer, message),
            id, kind: ['geojson', 'image'].includes(layer.kind) ? layer.kind : 'gee',
            bounds: messageLayerBounds(message, layer), visible: choices.current.visibility[id] ?? layer.visible };
          if (!existing) map.addLayer(spec);
          else map.replaceLayer(id, spec);
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
  const pendingThumbnails = layers.filter(layer => layer.thumbnailStatus === 'pending'
    && !thumbnails[thumbnailKey(conversationId, layer.id, layer.reloadVersion)]).slice(0, 24).map(layer => layer.id).join(',');
  useEffect(() => {
    if (!conversationId || !pendingThumbnails) return undefined;
    const abort = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = await chatApi.layerThumbnails(conversationId, pendingThumbnails, abort.signal);
        if (abort.signal.aborted || current.current == null || choices.current.id !== conversationId) return;
        const currentVersions = new Map(current.current.listLayers().map(layer => [layer.id, layer.reloadVersion]));
        const updates = {};
        for (const row of result.layers) {
          if (currentVersions.get(row.layer_id) !== row.reload_version || row.thumbnail_status === 'pending') continue;
          const url = previewUrl(row.thumbnail?.url);
          updates[thumbnailKey(conversationId, row.layer_id, row.reload_version)] = {
            thumbnailStatus: url ? 'ready' : 'unavailable', thumbnail: url ? { url } : null,
          };
        }
        if (Object.keys(updates).length) setThumbnails(previous => ({ ...previous, ...updates }));
      } catch { /* Retry temporary failures while this chat is open. */ }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1200);
    };
    timer = setTimeout(poll, 300);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [conversationId, pendingThumbnails]);
  const prepareConversationChange = focus => { focusIntent.current = focus ? shared.captureViewIntent('agent', true) : null; };
  const forgetConversation = id => {
    const scope = shared.service?.scope(`agent:${id}`);
    for (const layer of scope?.listLayers() || []) scope.removeLayer(layer.id);
    try { localStorage.removeItem(choicesKey(id)); }
    catch { /* Deletion still succeeds when browser storage is unavailable. */ }
  };
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
  const reloadLayer = async layer => {
    const cid = conversationId, scope = current.current, key = `${cid}:${layer.id}`;
    if (!scope || !layer.reloadable || reloading.current.has(key)) return;
    reloading.current.add(key);
    setLayerStatus(previous => ({ ...previous, [key]: { ...previous[key], reloading: true, error: '' } }));
    try {
      const result = await chatApi.reloadLayer(cid, layer.id);
      // Scope is captured before awaiting. Switching chats/modes cannot redirect
      // a result, and replaceLayer refuses to resurrect a removed layer.
      scope.replaceLayer(layer.id, messageLayerPresentation(result.layer, {}));
      if (alive.current) setLayerStatus(previous => ({ ...previous, [key]: { reloading: false, tiles: 'loading', error: '' } }));
    } catch (cause) {
      if (alive.current) setLayerStatus(previous => ({ ...previous, [key]: { ...previous[key], reloading: false, error: cause.message } }));
    } finally { reloading.current.delete(key); }
  };
  const bounds = useCallback(() => shared.service?.getCurrentView().bounds, [shared.service]);
  return { ready: shared.ready, layers: layers.map(layer => ({ ...layer,
    ...thumbnails[thumbnailKey(conversationId, layer.id, layer.reloadVersion)],
    reload: layerStatus[`${conversationId}:${layer.id}`] || {} })), error, configured: shared.configured,
    toggleLayer, removeLayer, focusLayer, reloadLayer, bounds, prepareConversationChange, forgetConversation };
}
