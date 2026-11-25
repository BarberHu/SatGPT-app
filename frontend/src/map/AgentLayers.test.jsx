import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentMap } from '../harness/hooks/useAgentMap';
import { MapService } from './mapService';

const holder = vi.hoisted(() => ({ shared: null, view: null }));
vi.mock('./SharedMapContext', () => ({ useSharedMap: () => holder.shared }));
function Probe({ id, messages }) { holder.view = useAgentMap(id, messages); return null; }

test('conversation layers keep choices and removals; late old-session projection never becomes visible or moves the camera', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const engine = { onStyleReady: () => () => {}, addLayer: vi.fn(), removeLayer: vi.fn(), setVisibility: vi.fn(), setBasicActive: vi.fn(), setView: vi.fn(), dispose: vi.fn() };
  const service = new MapService(engine);
  service.setMode('agent');
  holder.shared = { service, ready: true, configured: true, captureViewIntent: () => ({ setView: engine.setView }) };
  const node = document.createElement('div'); const root = createRoot(node);
  const messages = [{ job_id: 'same-job', layers: [{ url: 'https://earthengine.googleapis.com/v1/projects/test/maps/example/tiles/{z}/{x}/{y}', name: 'Result' }] }];
  const render = id => act(async () => root.render(<Probe id={id} messages={messages} />));
  try {
    await render('one');
    await act(async () => holder.view.toggleLayer('same-job-0', false));
    await render('two'); expect(holder.view.layers[0].visible).toBe(true);
    await act(async () => holder.view.removeLayer('same-job-0'));
    const old = service.scope('agent:one');
    await act(async () => old.addLayer({ id: 'late', kind: 'raster', url: 'https://example.test/{z}/{x}/{y}' }));
    expect(engine.addLayer.mock.lastCall[0].visible).toBe(false);
    old.setView({ zoom: 12 }); expect(engine.setView).not.toHaveBeenCalled();
    await render('one'); expect(holder.view.layers.find(layer => layer.id === 'same-job-0').visible).toBe(false);
    await render('two'); expect(holder.view.layers).toHaveLength(0);
    expect(engine.setView).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); service.dispose();
    localStorage.removeItem('satgpt:harness:layers:one'); localStorage.removeItem('satgpt:harness:layers:two');
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('OSM result references restore alongside GEE layers and stay in their own conversation', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const engine = { onStyleReady: () => () => {}, addLayer: vi.fn(), removeLayer: vi.fn(), setVisibility: vi.fn(),
    setBasicActive: vi.fn(), setView: vi.fn(), dispose: vi.fn() };
  const service = new MapService(engine);
  service.setMode('agent');
  holder.shared = { service, ready: true, configured: true, captureViewIntent: () => ({ setView: engine.setView }) };
  const root = createRoot(document.createElement('div'));
  const cid = 'webgis-' + 'a'.repeat(32), task = 'b'.repeat(32);
  const dataUrl = `/api/harness/conversations/${cid}/tasks/${task}/osm/${'c'.repeat(32)}.geojson`;
  const osm = { name: 'OSM roads', kind: 'geojson', data_url: dataUrl, renderAs: 'line', visible: false };
  const gee = { name: 'Flood extent', url: 'https://earthengine.googleapis.com/v1/projects/test/maps/example/tiles/{z}/{x}/{y}' };
  const messages = [{ job_id: task, layers: [gee, osm] }];
  const render = (id, rows) => act(async () => root.render(<Probe id={id} messages={rows} />));
  try {
    await render(cid, messages);
    expect(holder.view.layers.map(layer => layer.kind)).toEqual(['gee', 'geojson']);
    expect(holder.view.layers[1]).toMatchObject({ dataUrl, data: null, visible: false });
    await act(async () => holder.view.toggleLayer(task + '-1', true));
    expect(holder.view.layers[1].visible).toBe(true);
    await render('other', []);
    expect(holder.view.layers).toHaveLength(0);
    expect(engine.setVisibility.mock.lastCall[1]).toBe(false);
    await render(cid, messages);
    expect(holder.view.layers[1]).toMatchObject({ dataUrl, visible: true });
    expect(engine.setView).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    service.dispose();
    localStorage.removeItem('satgpt:harness:layers:' + cid);
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('FLEXTH history restores the protected overlay and its separate GeoTIFF downloads', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const engine = { onStyleReady: () => () => {}, addLayer: vi.fn(), removeLayer: vi.fn(),
    setVisibility: vi.fn(), setBasicActive: vi.fn(), dispose: vi.fn() };
  const service = new MapService(engine);
  service.setMode('agent');
  holder.shared = { service, ready: true, configured: true };
  const root = createRoot(document.createElement('div'));
  const cid = 'webgis-' + 'a'.repeat(32), task = 'b'.repeat(32), ref = 'c'.repeat(32);
  const url = `/api/previews/${cid}/${task}/${ref}.png`;
  const result = `/api/harness/conversations/${cid}/tasks/${task}/flexth/${ref}`;
  const image = { kind: 'image', name: 'Estimated water depth', url, thumbnail: { url },
    image_bounds: [32.53, 46.57, 32.67, 46.67], bounds: [32.54, 46.58, 32.66, 46.66],
    depth_url: result + '-depth.tif', extent_url: result + '-extent.tif' };
  try {
    await act(async () => root.render(<Probe id={cid} messages={[{ job_id: task, layers: [image] }]} />));
    expect(engine.addLayer.mock.lastCall[0]).toMatchObject({ kind: 'image', url,
      imageBounds: image.image_bounds, bounds: image.bounds, depthUrl: image.depth_url, extentUrl: image.extent_url });
    await act(async () => root.render(<Probe id="other" messages={[]} />));
    expect(engine.setVisibility.mock.lastCall[1]).toBe(false);
  } finally {
    await act(async () => root.unmount()); service.dispose();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('history projection looks up existing layers by ID and replaces only changed layers', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const engine = { onStyleReady: () => () => {}, addLayer: vi.fn(), removeLayer: vi.fn(), setVisibility: vi.fn(),
    setBasicActive: vi.fn(), setView: vi.fn(), dispose: vi.fn() };
  const service = new MapService(engine);
  service.setMode('agent');
  holder.shared = { service, ready: true, configured: true, captureViewIntent: () => ({ setView: engine.setView }) };
  const id = 'projection';
  const scope = service.scope(`agent:${id}`);
  const root = createRoot(document.createElement('div'));
  const tile = version => `https://earthengine.googleapis.com/v1/projects/test/maps/${version}/tiles/{z}/{x}/{y}`;
  const layers = Array.from({ length: 12 }, (_, index) => ({ name: `Layer ${index}`, url: tile(0) }));
  const render = rows => act(async () => root.render(<Probe id={id} messages={[{
    job_id: 'history', layers: rows, previews: [{ name: 'Layer 0', url: '/api/previews/legacy.png' }],
  }]} />));
  try {
    await render(layers);
    const lookup = vi.spyOn(scope, 'getLayer');
    const list = vi.spyOn(service, 'listLayers');
    engine.addLayer.mockClear();
    await render(layers.map(layer => ({ ...layer })));
    expect(lookup.mock.calls.map(([layerId]) => layerId)).toEqual(layers.map((_, index) => `history-${index}`));
    expect(list).toHaveBeenCalledExactlyOnceWith(`agent:${id}`);
    expect(engine.addLayer).not.toHaveBeenCalled();

    await act(async () => {
      holder.view.toggleLayer('history-0', false);
      scope.setOpacity('history-0', 0.35);
      holder.view.removeLayer('history-2');
    });
    const changed = layers.map(layer => ({ ...layer }));
    changed[0].code = 'result = ee.Image(1)';
    Object.assign(changed[1], { reload_version: 1, url: tile(1) });
    Object.assign(changed[2], { reload_version: 1, url: tile(1) });
    await render(changed);
    expect(engine.addLayer.mock.calls.map(([layer]) => layer.id)).toEqual([
      service.physical(`agent:${id}`, 'history-0'), service.physical(`agent:${id}`, 'history-1'),
    ]);
    expect(scope.getLayer('history-0')).toMatchObject({ code: changed[0].code, visible: false, opacity: 0.35,
      thumbnail: { url: '/api/previews/legacy.png' } });
    expect(scope.getLayer('history-1')).toMatchObject({ reloadVersion: 1, url: tile(1) });
    expect(scope.getLayer('history-2')).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    service.dispose();
    localStorage.removeItem(`satgpt:harness:layers:${id}`);
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
