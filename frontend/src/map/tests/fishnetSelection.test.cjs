const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
require('sucrase/register');

const geojsonvt = require('geojson-vt');
const { indexFishnetFeatures, getOriginalFishnetRing, loadFishnetData } = require('../../utils/fishnetSelection');
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson'), 'utf8'));
const featuresByFid = indexFishnetFeatures(data);
const original = featuresByFid.get('3039');
const ring = original.geometry.coordinates[0];
const bounds = { west: ring[0][0], south: ring[0][1], east: ring[1][0], north: ring[2][1] };
const projectY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
const tileIndex = geojsonvt({ type: 'FeatureCollection', features: [original] }, { extent: 8192, buffer: 2048, maxZoom: 18 });

function renderedHit(zoom, xFraction, yFraction) {
  const lng = bounds.west + (bounds.east - bounds.west) * xFraction;
  const lat = bounds.south + (bounds.north - bounds.south) * yFraction;
  const x = Math.floor((lng + 180) / 360 * 2 ** zoom);
  const y = Math.floor(projectY(lat) * 2 ** zoom);
  const feature = tileIndex.getTile(zoom, x, y).features.find(f => f.tags.FID === 3039);
  return {
    type: 'Feature', properties: feature.tags,
    geometry: { type: 'Polygon', coordinates: [feature.geometry[0].map(([px, py]) => [
      (x + px / 8192) / 2 ** zoom * 360 - 180,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / 8192) / 2 ** zoom))) * 180 / Math.PI,
    ])] },
  };
}

test('FID lookup restores full precision across real tile clipping at five zoom levels and nine click positions', () => {
  assert.equal(featuresByFid.size, data.features.length);
  const clipped = renderedHit(7, 0.5, 0.1);
  assert.ok(Math.max(...clipped.geometry.coordinates[0].map(p => p[1])) < bounds.north - 0.2);
  for (const zoom of [4, 6, 7, 9, 12]) {
    for (const x of [0.01, 0.5, 0.99]) for (const y of [0.01, 0.5, 0.99]) {
      assert.deepEqual(getOriginalFishnetRing(renderedHit(zoom, x, y), featuresByFid), ring);
    }
  }
  assert.deepEqual(getOriginalFishnetRing({ properties: { FID: '0' } }, featuresByFid), featuresByFid.get('0').geometry.coordinates[0]);
  assert.equal(getOriginalFishnetRing({ ...clipped, properties: {} }, featuresByFid), null);
  assert.equal(getOriginalFishnetRing({ ...clipped, properties: { FID: -1 } }, featuresByFid), null);
  const copy = getOriginalFishnetRing(clipped, featuresByFid);
  copy[0][0] = 0;
  assert.deepEqual(original.geometry.coordinates[0], ring);
  assert.notEqual(copy[0][0], ring[0][0]);
});

test('failed grid loads can retry, and successful loads share one original dataset', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  try {
    await assert.rejects(loadFishnetData(), /503/);
    fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => data }));
    const first = loadFishnetData();
    assert.equal(loadFishnetData(), first);
    const loaded = await first;
    assert.equal(loaded.geojson, data);
    assert.equal(loaded.featuresByFid.get('3039'), original);
    assert.equal(fetch.mock.callCount(), 2);
  } finally { fetch.mock.restore(); }
});

test('real controller selection, displayed boundary, and outgoing analysis requests agree for every click', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const name of ['window', 'document', 'localStorage', 'HTMLElement', 'Element', 'HTMLCanvasElement', 'getComputedStyle']) {
    globalThis[name] = name === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[name];
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.vi = { fn: (impl = () => {}) => mock.fn(impl) };
  const requests = [];
  const apiPath = require.resolve('../../api/httpClient');
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
    __esModule: true, default: { post: async (endpoint, params) => {
      assert.equal(endpoint, '/api/preset-layers');
      requests.push(params); return { data: { status: 'empty', layer: null } };
    } },
  } };
  const repositoryPath = require.resolve('../../repositories/businessLayerRepository');
  const repositoryExports = require(repositoryPath);
  require.cache[repositoryPath] = { id: repositoryPath, filename: repositoryPath, loaded: true, exports: {
    ...repositoryExports, __esModule: true, default: { load: async () => [], save: async () => {} },
  } };
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { AppProvider, useAppContext } = require('../../context/AppContext');
  const { requestPresetLayer } = require('../../api/presetLayers');
  const analyze = () => requestPresetLayer({ id: 'precision', presetId: 'slopeSteepness', aoi: context.selectedAOI, params: {} });
  const Controller = require('../basic/BasicMapController').default;
  const { FakeMap } = require('./fakeMap');
  const { BasicMapPort } = require('../BasicMapPort');
  const raw = new FakeMap();
  const extension = new BasicMapPort(raw);
  extension.activate(true);
  const map = extension.port;
  let context;
  function Probe() {
    context = useAppContext();
    return React.createElement(Controller, { map, active: true });
  }
  const root = createRoot(document.getElementById('root'));
  const logs = mock.method(console, 'log', () => {});
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(AppProvider, null, React.createElement(Probe)))));
    await React.act(async () => new Promise(resolve => setTimeout(resolve, 80)));
    const gridSource = raw.getSource('satgpt-basic-aux:grid_cell');
    assert.equal(gridSource.setData.mock.callCount(), 1, 'disposed StrictMode setup must not update its source');
    assert.equal(gridSource.setData.mock.calls[0].arguments[0], data);
    for (const zoom of [4, 6, 7, 9, 12]) {
      raw.view.zoom = zoom;
      for (const x of [0.01, 0.5, 0.99]) for (const y of [0.01, 0.5, 0.99]) {
        const hit = renderedHit(zoom, x, y);
        raw.queryRenderedFeatures = () => [hit, hit];
        const before = requests.length;
        await React.act(async () => raw.fire('click', { point: { x, y } }));
        assert.equal(requests.length, before, 'grid selection alone must not start analysis');
        await analyze();
        assert.equal(requests.length, before + 1);
        assert.deepEqual(context.selectedAOI.bounds, bounds);
        assert.deepEqual(context.selectedGridCords, ring);
        const displayed = raw.getSource('satgpt-basic-aux:analysis-aoi').data;
        const request = requests.at(-1);
        assert.deepEqual(displayed.geometry.coordinates[0], ring);
        assert.deepEqual(request.aoi.geojson, displayed);
        assert.deepEqual(request.aoi.geojson.geometry.coordinates[0], ring);
      }
    }
    const selected = context.selectedAOI;
    const before = requests.length;
    raw.queryRenderedFeatures = () => [{ ...renderedHit(7, 0.5, 0.1), properties: { FID: -1 } }];
    await React.act(async () => raw.fire('click', { point: { x: 1, y: 1 } }));
    assert.equal(context.selectedAOI, selected);
    assert.equal(requests.length, before);
    assert.match(context.warning, /complete grid boundary/);
    // FID 0 must work, and changing to a different grid must replace all scopes.
    raw.queryRenderedFeatures = () => [{ properties: { FID: 0 } }];
    await React.act(async () => raw.fire('click', { point: { x: 1, y: 1 } }));
    assert.deepEqual(context.selectedGridCords, featuresByFid.get('0').geometry.coordinates[0]);
    assert.equal(context.warning, '');
    await analyze();
    assert.deepEqual(requests.at(-1).aoi.geojson, raw.getSource('satgpt-basic-aux:analysis-aoi').data);
    assert.equal(raw.events.filter(e => e.event === 'click' && e.layer === 'satgpt-basic-aux:grid_cell-layer').length, 1);
  } finally {
    await React.act(async () => root.unmount());
    extension.dispose();
    logs.mock.restore();
    dom.window.close();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
