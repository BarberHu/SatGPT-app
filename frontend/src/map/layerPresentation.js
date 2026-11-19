/** Display contract for layer cards; independent of the map engine and DSH. */
const namedColors = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', orange: '#ffa500',
  gray: '#808080', grey: '#808080', purple: '#800080', brown: '#a52a2a', navy: '#000080' };
export function legendColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (namedColors[text]) return namedColors[text];
  const hex = text.replace(/^#/, '');
  if (/^[\da-f]{3}$/.test(hex)) return `#${[...hex].map(c => c + c).join('')}`;
  return /^[\da-f]{6}$/.test(hex) ? `#${hex}` : null;
}
const text = (value, limit = 200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const PREVIEW_PATH = /^\/api\/previews\/(?:webgis-[a-f0-9]{32}\/[a-f0-9]{32}\/[a-f0-9]{32}|[\w-]+)\.png$/;
export const previewUrl = value => typeof value === 'string' && PREVIEW_PATH.test(value) ? value : null;

export function layerLegend(visualization = {}, declared = {}) {
  const raw = Array.isArray(visualization.palette) ? visualization.palette.slice(0, 256) : [];
  const colors = raw.map(legendColor);
  if (raw.length && colors.every(Boolean)) {
    const min = visualization.min, max = visualization.max;
    const range = finite(min) && finite(max) && min <= max;
    const labels = declared?.labels || (declared?.items?.every((item, i) => item.color === colors[i] && item.value === min + i) ? declared.items.map(item => item.label) : null);
    if (declared?.type === 'categorical' && Array.isArray(labels)
        && labels.length === colors.length && range && Number.isInteger(min)
        && max - min === colors.length - 1 && labels.every(label => text(label))) {
      return { type: 'categorical', items: colors.map((color, i) => ({ color, value: min + i, label: text(labels[i], 100) })) };
    }
    const swatches = declared?.type === 'composite' && Array.isArray(declared.swatches)
      ? declared.swatches.slice(0, 12).filter(item => legendColor(item.color) && text(item.label)).map(item => ({ label: text(item.label), color: legendColor(item.color) })) : [];
    return { type: swatches.length ? 'composite' : 'continuous', colors, min: range ? min : null, max: range ? max : null, ...(swatches.length ? { swatches } : {}) };
  }
  const bands = Array.isArray(visualization.bands) ? visualization.bands.map(band => text(band, 60)).filter(Boolean) : [];
  if (bands.length === 3 && !raw.length) return { type: 'rgb', bands };
  return { type: 'unavailable' };
}

export function layerPresentation(spec) {
  const metadata = spec.metadata || {};
  return {
    thumbnail: previewUrl(spec.thumbnail?.url) ? { url: previewUrl(spec.thumbnail.url) } : null,
    metadata: { source: text(metadata.source) || 'Google Earth Engine', datasetId: text(metadata.dataset_id || metadata.datasetId, 240),
      observedAt: text(metadata.observed_at || metadata.observedAt, 100), unit: text(metadata.unit, 40),
      description: text(metadata.description, 2400), createdAt: text(metadata.created_at || metadata.createdAt, 100) },
    visualization: spec.visualization || {},
    legend: layerLegend(spec.visualization || {}, spec.legend),
  };
}

export function messageLayerPresentation(layer, message) {
  // Only an exact name match can associate an old preview with an old layer.
  // Message-wide previews can depict a different image or visualization.
  const matching = (message.previews || []).filter(item => item.name === layer.name && previewUrl(item.url));
  return { ...layer, thumbnail: layer.thumbnail || (matching.length === 1 ? { url: matching[0].url } : null),
    metadata: { ...layer.metadata, created_at: layer.metadata?.created_at || message.created_at } };
}
