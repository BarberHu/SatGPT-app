import { describe, expect, test, vi } from 'vitest';
import { MapService } from '../../map/mapService';
import { normalizeLayer } from '../../map/layerSpec';

function engine() {
  let styleReady;
  let viewChange;
  return {
    addLayer: vi.fn(), removeLayer: vi.fn(), setVisibility: vi.fn(),
    getView: vi.fn(() => ({ bounds: [100, 10, 101, 11] })),
    setView: vi.fn(), captureSnapshot: vi.fn(() => 'data:image/png;base64,AA=='),
    onStyleReady: vi.fn(callback => { styleReady = callback; return vi.fn(); }),
    onViewChange: vi.fn(callback => { viewChange = callback; return vi.fn(); }),
    dispose: vi.fn(), styleReady: () => styleReady(), viewChange: () => viewChange(),
  };
}

const tile = version => `https://earthengine.googleapis.com/v1/projects/p/maps/v${version}/tiles/{z}/{x}/{y}`;
const reloadableLayer = (id, version = 0) => {
  const code = 'result = ee.Image(1)';
  return { id, name: id, kind: 'gee', url: tile(version), code,
    generation: { version: 1, code }, reloadable: true, reload_version: version };
};

describe('map service boundary', () => {
  test('adds a GEE layer, controls visibility, and restores it after style reload', () => {
    const driver = engine();
    const service = new MapService(driver);
    const layer = service.addLayer({
      id: 'run-1', name: 'Flood', kind: 'gee',
      url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
    });
    expect(driver.addLayer).toHaveBeenCalledWith({ ...layer, id: 'scope--default--run-1' });
    expect(service.getCurrentView().bounds).toEqual([100, 10, 101, 11]);
    service.setVisibility('run-1', false);
    expect(driver.setVisibility).toHaveBeenCalledWith('scope--default--run-1', false);
    driver.styleReady();
    expect(driver.addLayer).toHaveBeenCalledTimes(2);
    expect(driver.addLayer.mock.lastCall[0].visible).toBe(false);
    service.removeLayer('run-1');
    expect(driver.removeLayer).toHaveBeenCalledWith('scope--default--run-1');
    service.dispose();
    expect(driver.dispose).toHaveBeenCalled();
  });

  test('rejects an untrusted GEE URL before it reaches Mapbox', () => {
    expect(() => normalizeLayer({ kind: 'gee', url: 'https://evil.example/tiles/{z}/{x}/{y}' })).toThrow();
  });

  test('reports map view changes through the adapter', () => {
    const driver = engine();
    const service = new MapService(driver);
    const listener = vi.fn();
    const unsubscribe = service.subscribeView(listener);
    driver.viewChange();
    expect(listener).toHaveBeenCalledWith({ bounds: [100, 10, 101, 11] });
    unsubscribe();
    service.dispose();
  });

  test('replacing a layer retains its code, identity, paint order, and display choices', () => {
    const driver = engine();
    const paint = new Map();
    driver.addLayer.mockImplementation(layer => {
      paint.delete(layer.id);
      paint.set(layer.id, layer);
    });
    driver.moveLayer = id => {
      const layer = paint.get(id);
      paint.delete(id);
      paint.set(id, layer);
    };
    const service = new MapService(driver);
    service.setMode('agent');
    service.selectConversation('a');
    const scope = service.scope('agent:a');
    const original = scope.addLayer({ ...reloadableLayer('one'), visible: false, opacity: .35 });
    scope.addLayer(reloadableLayer('two'));
    const originalOrder = [...paint.keys()];
    const updated = scope.replaceLayer('one', reloadableLayer('one', 1));
    expect(updated).toMatchObject({ id: original.id, code: original.code, generation: original.generation,
      visible: false, opacity: .35, url: tile(1), reloadVersion: 1 });
    expect([...paint.keys()]).toEqual(originalOrder);
    expect(driver.setView).not.toHaveBeenCalled();
    expect(scope.listLayers()).toHaveLength(2);
    expect(scope.replaceLayer('one', reloadableLayer('one'))).toBe(false);
    service.dispose();
  });

  test('scoped lookup distinguishes the same logical layer ID across conversations', () => {
    const service = new MapService(engine());
    const first = service.scope('agent:a');
    const second = service.scope('agent:b');
    const older = first.addLayer(reloadableLayer('same'));
    const newer = second.addLayer(reloadableLayer('same', 1));
    expect(first.getLayer('same')).toBe(older);
    expect(second.getLayer('same')).toBe(newer);
    first.removeLayer('same');
    expect(first.getLayer('same')).toBeUndefined();
    expect(second.getLayer('same')).toBe(newer);
    service.dispose();
  });

  test('late replacements stay in their original scope and cannot restore removed layers', () => {
    const driver = engine();
    const service = new MapService(driver);
    service.setMode('agent');
    service.selectConversation('a');
    const first = service.scope('agent:a'), other = service.scope('agent:b');
    first.addLayer(reloadableLayer('one'));
    other.addLayer(reloadableLayer('two'));
    service.selectConversation('b');
    first.replaceLayer('one', reloadableLayer('one', 1));
    expect(driver.addLayer).toHaveBeenLastCalledWith(expect.objectContaining({
      id: service.physical('agent:a', 'one'), visible: false, url: tile(1),
    }));
    expect(other.listLayers()[0].url).toBe(tile(0));
    first.removeLayer('one');
    expect(first.replaceLayer('one', reloadableLayer('one', 2))).toBe(false);
    expect(first.listLayers()).toHaveLength(0);
    service.dispose();
  });
});
