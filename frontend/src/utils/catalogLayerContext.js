const normalizeContextPart = (value, fallback = '') => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return String(value);
};

export const buildCatalogLayerTimeSignature = (layer, dateWindow = {}) => [
  normalizeContextPart(layer?.id, 'unknown-layer'),
  normalizeContextPart(dateWindow?.mode, 'static'),
  normalizeContextPart(dateWindow?.start_date),
  normalizeContextPart(dateWindow?.end_date),
  normalizeContextPart(dateWindow?.year),
  normalizeContextPart(dateWindow?.month),
].join(':');

export const buildCatalogLayerContextKey = ({
  baseContextKey,
  layer,
  dateWindow,
}) => [
  normalizeContextPart(baseContextKey, 'no-context'),
  buildCatalogLayerTimeSignature(layer, dateWindow),
].join('|');
