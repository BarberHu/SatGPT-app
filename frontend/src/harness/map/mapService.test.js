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
});
