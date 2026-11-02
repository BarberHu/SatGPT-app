export const AGENT_VIEW_STORAGE_KEY = 'satgpt:harness:map-view:v1';

export function normalizeBounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bounds = value.map(Number);
  const [west, south, east, north] = bounds;
  if (!bounds.every(Number.isFinite)
    || west < -180 || east > 180 || west >= east
    || south < -85 || north > 85 || south >= north) return null;
  return bounds;
}

export function messageLayerBounds(message, layer) {
  return normalizeBounds(layer?.bounds || message?.bounds);
}

export function latestLayerBounds(messages) {
  for (const message of [...messages].reverse()) {
    for (const layer of [...(message.layers || [])].reverse()) {
      const bounds = messageLayerBounds(message, layer);
      if (bounds) return bounds;
    }
  }
  return null;
}

export function readAgentView() {
  try {
    const view = JSON.parse(window.localStorage.getItem(AGENT_VIEW_STORAGE_KEY));
    const center = view?.center;
    const zoom = Number(view?.zoom);
    if (!Array.isArray(center) || center.length !== 2
      || !center.every(Number.isFinite) || center[0] < -180 || center[0] > 180
      || center[1] < -85 || center[1] > 85 || !Number.isFinite(zoom)
      || zoom < 0 || zoom > 24) return null;
    return { center, zoom };
  } catch {
    return null;
  }
}

export function saveAgentView(view) {
  if (!view?.center || !Number.isFinite(view.zoom)) return;
  try {
    window.localStorage.setItem(AGENT_VIEW_STORAGE_KEY, JSON.stringify({
      center: view.center, zoom: view.zoom,
    }));
  } catch {
    // The map remains usable when storage is unavailable.
  }
}
