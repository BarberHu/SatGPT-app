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
