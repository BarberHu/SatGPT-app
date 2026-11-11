import { FLOOD_RASTER_LAYER_CONFIG, WILDFIRE_RASTER_LAYER_CONFIG,
  LANDSLIDE_RASTER_LAYER_CONFIG, CONTEXT_RASTER_LAYER_CONFIG } from './agentRasterLayerConfig';

export const PRESET_VERSION = 1;
export const presetThemes = ['flood', 'wildfire', 'landslide'];
// Reuse the supported raster catalog. Rendering legends come from the backend,
// never from the legacy illustrative catalog legends.
export const presetLayerCatalog = Object.entries({ flood: FLOOD_RASTER_LAYER_CONFIG,
  wildfire: WILDFIRE_RASTER_LAYER_CONFIG, landslide: LANDSLIDE_RASTER_LAYER_CONFIG,
  context: CONTEXT_RASTER_LAYER_CONFIG }).flatMap(([theme, entries]) => entries.map(entry => ({
    ...entry, theme,
    title: entry.key === 'singleInundationEvent' ? 'JRC annual water classification'
      : entry.key === 'lclu' ? 'Land Cover' : entry.title,
    infoText: entry.key === 'singleInundationEvent'
      ? 'Historical permanent and seasonal water classes from JRC yearly history (1984–2021). Seasonal water is not an extracted flood event.' : entry.infoText,
    model: ['wildfireRisk', 'landslideRisk'].includes(entry.key),
    form: ['singleInundationEvent', 'inundationHotspot'].includes(entry.key) ? 'years'
      : entry.hasRecentWindowControl ? 'dates' : 'fixed',
  })));
export const presetById = id => presetLayerCatalog.find(entry => entry.key === id);
export const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function defaultPresetParams(preset, now = new Date()) {
  if (preset.form === 'years') return { year_start: 2021, year_end: 2021 };
  if (preset.form !== 'dates') return {};
  const end = localDate(now);
  const start = new Date(now); start.setDate(start.getDate() - preset.defaultRecentWindow);
  return { time_start: localDate(start), time_end: end, ...(preset.model ? { cloud_threshold: 50 } : {}) };
}
export function validPresetParams(preset, params) {
  if (preset.form === 'fixed') return {};
  if (preset.form === 'years') {
    const values = ['year_start', 'year_end'].map(key => Number(params[key]));
    if (!values.every(value => Number.isInteger(value) && value >= 1984 && value <= 2021) || values[0] > values[1])
      throw new Error('Choose an ordered year range between 1984 and 2021.');
    return { year_start: values[0], year_end: values[1] };
  }
  const min = preset.model ? '2020-03-28' : '2000-11-01';
  const today = localDate(new Date());
  const { time_start, time_end } = params;
  if (![time_start, time_end].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)))
    || time_start < min || time_start >= time_end || time_end > today)
    throw new Error(`Choose dates from ${min} through today. The end date is exclusive.`);
  const days = (Date.parse(time_end) - Date.parse(time_start)) / 86400000;
  if (days < preset.minRecentWindow || days > preset.maxRecentWindow)
    throw new Error(`Choose a window of ${preset.minRecentWindow}–${preset.maxRecentWindow} days.`);
  const cloud = Number(params.cloud_threshold);
  if (preset.model && (!Number.isFinite(cloud) || cloud < 0 || cloud > 100)) throw new Error('Cloud threshold must be between 0 and 100.');
  return { time_start, time_end, ...(preset.model ? { cloud_threshold: cloud } : {}) };
}
