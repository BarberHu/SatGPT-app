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
