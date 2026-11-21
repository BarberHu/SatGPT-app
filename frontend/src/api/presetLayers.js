import httpClient from './httpClient';
import { normalizeLayer } from '../map/layerSpec';

const GEE_POPULATION_PREVIEW = /^https:\/\/earthengine\.googleapis\.com\/v1\/projects\/[\w.-]+\/thumbnails\/[\w.-]+:getPixels$/;

export async function requestPresetLayer(selection, signal) {
  const { data } = await httpClient.post('/api/preset-layers', {
    preset_id: selection.presetId, aoi: selection.aoi, ...selection.params,
  }, { signal, timeout: 240000, fallbackMessage: 'Unable to generate this layer. Please retry.' });
  if (!['ready', 'empty'].includes(data.status)) throw new Error('Invalid preset result.');
  const layer = data.layer ? normalizeLayer({ ...data.layer, id: selection.id,
    visible: selection.visible, opacity: selection.opacity }) : null;
  const thumbnail = data.layer?.thumbnail?.url;
  if (selection.presetId === 'populationDensity' && layer && typeof thumbnail === 'string' && GEE_POPULATION_PREVIEW.test(thumbnail)) {
    layer.thumbnail = { url: thumbnail };
  }
  return { status: data.status, layer, effectiveParams: data.effective_params, note: data.note || '' };
}
