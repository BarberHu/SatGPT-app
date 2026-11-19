import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MapLayerCard from './MapLayerCard';
import { layerLegend, layerPresentation, messageLayerPresentation } from '../../map/layerPresentation';
import { normalizeLayer } from '../../map/layerSpec';
import { MapService } from '../../map/mapService';

const raw = { id: 'terrain', kind: 'gee', name: '地形高程', bounds: [119, 30, 120, 31],
  url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
  thumbnail: { url: '/api/previews/test.png' }, metadata: { source: 'NASA SRTM', observed_at: '2000-02', unit: 'm', dataset_id: 'USGS/SRTMGL1_003' },
  visualization: { min: 0, max: 300, palette: ['ffffff', '78ad8b', '315449'] } };

test('layer metadata and actual rendering palette survive map visibility and style restoration', () => {
  let restore;
  const engine = { addLayer: vi.fn(), removeLayer: vi.fn(), setVisibility: vi.fn(), onStyleReady: f => { restore = f; } };
  const map = new MapService(engine);
  map.addLayer(raw); map.setVisibility('terrain', false); restore();
  const layer = map.listLayers()[0];
  expect(layer.metadata.observedAt).toBe('2000-02');
  expect(layer.thumbnail.url).toBe('/api/previews/test.png');
  expect(layer.legend.colors).toEqual(['#ffffff', '#78ad8b', '#315449']);
  expect(layer.legend.min).toBe(0); expect(layer.legend.max).toBe(300);
  expect(engine.addLayer.mock.lastCall[0]).toMatchObject({ visible: false, thumbnail: layer.thumbnail });
});

test('legends respect class order, numeric ranges, RGB bands, missing values and unsafe inputs', () => {
  const vis = { min: 1, max: 2, palette: ['00f', 'red'] };
  expect(layerLegend(vis, { type: 'categorical', labels: ['水体', '其他'] }).items).toEqual([
    { color: '#0000ff', value: 1, label: '水体' }, { color: '#ff0000', value: 2, label: '其他' }]);
  expect(layerLegend(vis, { type: 'categorical', labels: ['只有一项'] }).type).toBe('continuous');
  expect(layerLegend({ ...vis, min: 0, max: 100 }, { type: 'categorical', labels: ['a', 'b'] }).type).toBe('continuous');
  expect(layerLegend({ bands: ['B4', 'B3', 'B2'] })).toEqual({ type: 'rgb', bands: ['B4', 'B3', 'B2'] });
  expect(layerLegend({}).type).toBe('unavailable');
  expect(layerLegend({ palette: ['url(https://example.invalid)'] }).type).toBe('unavailable');
  expect(layerLegend({ palette: ['blue', 'white'] }).min).toBeNull();
  expect(layerPresentation({ thumbnail: { url: 'https://example.invalid/image.png' } }).thumbnail).toBeNull();
});

test('old previews are matched by exact name only; generation date never masquerades as observation date', () => {
  const message = { created_at: '2026-11-02T00:00:00Z', previews: [{ name: 'another', url: '/api/previews/test.png' }] };
  expect(layerPresentation(messageLayerPresentation({ name: 'layer' }, message))).toMatchObject({ thumbnail: null, metadata: { observedAt: '', createdAt: message.created_at } });
  expect(layerPresentation(messageLayerPresentation({ name: 'another' }, message)).thumbnail.url).toBe('/api/previews/test.png');
});

test('card has real static preview, metadata, legend, visibility/details/locate/remove and no analysis action', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');document.body.appendChild(node);const root = createRoot(node);
  const onToggle = vi.fn(), onFocus = vi.fn(), onRemove = vi.fn();
  const layer = normalizeLayer(raw);
  try {
    await act(async () => root.render(<MapLayerCard layer={layer} onToggle={onToggle} onFocus={onFocus} onRemove={onRemove} />));
    expect(node.textContent).toContain('2000-02');expect(node.textContent).toContain('NASA SRTM');
    expect(node.textContent).toContain('Legend · m');expect(node.textContent).toContain('300');
    expect(node.textContent).not.toContain('分析当前区域');
    expect(node.querySelector('img').getAttribute('src')).toBe('/api/previews/test.png');
    await act(async () => node.querySelector('[aria-label="View layer preview 地形高程"]').click());
    expect(document.querySelector('[role=dialog] img').getAttribute('src')).toBe('/api/previews/test.png');
    await act(async () => document.querySelector('[role=dialog] button:last-child').click());
    await act(async () => node.querySelector('input').click());expect(onToggle).toHaveBeenCalledWith('terrain', false);
    await act(async () => node.querySelector('[aria-label="Layer details 地形高程"]').click());
    expect(node.textContent).toContain('USGS/SRTMGL1_003');
    await act(async () => node.querySelector('[aria-label="Zoom to 地形高程"]').click());expect(onFocus).toHaveBeenCalledWith(layer);
    await act(async () => node.querySelector('[aria-label="Remove 地形高程"]').click());expect(onRemove).toHaveBeenCalledWith('terrain');
    await act(async () => node.querySelector('.agent-layer-thumbnail img').dispatchEvent(new Event('error')));
    expect(node.querySelector('[aria-label="Static preview unavailable"]').textContent).toContain('Preview unavailable');
  } finally { await act(async () => root.unmount());node.remove();delete globalThis.IS_REACT_ACT_ENVIRONMENT; }
});

test('normal reload lives in details while unavailable and running layers keep a direct, guarded action', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  const onReload = vi.fn(), layer = { ...normalizeLayer(raw), reloadable: true };
  const render = (reload, overrides) => root.render(<MapLayerCard layer={{ ...layer, ...overrides, reload }} onReload={onReload} />);
  try {
    await act(async () => render({}));
    expect(node.querySelector('[aria-label="Reload 地形高程"]')).toBeNull();
    await act(async () => node.querySelector('[aria-label="Layer details 地形高程"]').click());
    await act(async () => node.querySelector('[aria-label="Reload 地形高程"]').click());
    expect(onReload.mock.calls[0][0].id).toBe(layer.id);
    await act(async () => node.querySelector('[aria-label="Layer details 地形高程"]').click());
    await act(async () => render({ tiles: 'error', error: 'GEE unavailable' }));
    expect(node.textContent).toContain('Layer unavailable or expired');
    expect(node.querySelector('[role="alert"]').textContent).toBe('GEE unavailable');
    expect(node.querySelector('[aria-label="Reload 地形高程"]').disabled).toBe(false);
    await act(async () => render({ reloading: true }));
    expect(node.querySelector('[role="status"]').textContent).toBe('Reloading from Earth Engine…');
    expect(node.querySelector('[aria-label="Reload 地形高程"]').disabled).toBe(true);
    expect(node.querySelectorAll('[aria-label="Reload 地形高程"]')).toHaveLength(1);
    await act(async () => render({ tiles: 'error' }, { reloadable: false, reloadUnavailableReason: 'Missing original scope' }));
    const legacyReload = node.querySelector('[aria-label="Reload 地形高程"]');
    expect(legacyReload.title).toBe('Missing original scope');
    expect(legacyReload.disabled).toBe(true);
  } finally { await act(async () => root.unmount()); node.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; }
});

test('preserves a server-issued conversation and task scoped thumbnail path', () => {
  const id = 'a'.repeat(32);
  const url = '/api/previews/webgis-' + id + '/' + id + '/' + id + '.png';
  expect(layerPresentation({ thumbnail: { url } }).thumbnail).toEqual({ url });
  expect(layerPresentation({ thumbnail: { url: '/api/previews/../unsafe.png' } }).thumbnail).toBeNull();
});
