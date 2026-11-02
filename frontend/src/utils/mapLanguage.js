const englishName = () => ['coalesce', ['get', 'name_en'], ['get', 'name']];

function englishText(value) {
  if (typeof value === 'string') {
    if (!/\{name(?:_[\w-]+)?\}/.test(value)) return value;
    const parts = value.split(/(\{[\w:-]+\})/g);
    const expressions = parts.filter(Boolean).map(part => /^\{name/.test(part) ? englishName()
      : /^\{[\w:-]+\}$/.test(part) ? ['get', part.slice(1, -1)] : part);
    return expressions.length === 1 ? expressions[0] : ['concat', ...expressions];
  }
  if (!Array.isArray(value)) return value;
  // Keep the local-name fallback intact and make repeated style events idempotent.
  if (value[0] === 'coalesce' && value[1]?.[0] === 'get' && value[1][1] === 'name_en') return value;
  if (value[0] === 'get' && value.length === 2 && /^name(?:_[\w-]+)?$/.test(value[1])) return englishName();
  if (value[0] === 'literal') return value;
  return value.map(englishText);
}

/** Prefer provider-supplied English names without changing the basemap or data. */
export function applyEnglishMapLabels(map) {
  for (const layer of map.getStyle?.()?.layers || []) {
    const field = layer.layout?.['text-field'];
    if (layer.type !== 'symbol' || field == null) continue;
    const translated = englishText(field);
    if (JSON.stringify(field) !== JSON.stringify(translated)) {
      map.setLayoutProperty(layer.id, 'text-field', translated);
    }
  }
}
