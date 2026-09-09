import {
  bindMapEvents,
  reconcileRasterLayer,
} from './mapLifecycle';

const createMap = () => {
  const layers = new Map();
  const sources = new Map();
  return {
    addLayer: jest.fn((definition) => layers.set(definition.id, definition)),
    addSource: jest.fn((id, definition) => sources.set(id, {
      ...definition,
      setTiles: jest.fn((tiles) => {
        sources.get(id).tiles = tiles;
      }),
    })),
    getLayer: jest.fn((id) => layers.get(id)),
    getSource: jest.fn((id) => sources.get(id)),
    off: jest.fn(),
    on: jest.fn(),
    removeLayer: jest.fn((id) => layers.delete(id)),
    removeSource: jest.fn((id) => sources.delete(id)),
    setLayoutProperty: jest.fn(),
    setPaintProperty: jest.fn(),
  };
};

describe('map lifecycle helpers', () => {
  test('unbinds every global and delegated event with the same handler', () => {
    const map = createMap();
    const click = jest.fn();
    const idle = jest.fn();
    const cleanup = bindMapEvents(map, [
      { event: 'click', layerId: 'grid', handler: click },
      { event: 'idle', handler: idle },
    ]);

    cleanup();

    expect(map.on.mock.calls).toEqual([
      ['click', 'grid', click],
      ['idle', idle],
    ]);
    expect(map.off.mock.calls).toEqual([
      ['click', 'grid', click],
      ['idle', idle],
    ]);
  });

  test('changes visibility and opacity without rebuilding the source', () => {
    const map = createMap();
    reconcileRasterLayer(map, {
      layerId: 'water-layer',
      sourceId: 'water',
      tileUrl: 'https://tiles/one',
      previousTileUrl: null,
    });
    map.addSource.mockClear();
    map.removeSource.mockClear();

    const result = reconcileRasterLayer(map, {
      layerId: 'water-layer',
      sourceId: 'water',
      tileUrl: 'https://tiles/one',
      previousTileUrl: 'https://tiles/one',
      visible: false,
      opacity: 0.4,
    });

    expect(result).toEqual({ sourceChanged: false, status: 'reused' });
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.removeSource).not.toHaveBeenCalled();
    expect(map.setLayoutProperty).toHaveBeenCalledWith('water-layer', 'visibility', 'none');
    expect(map.setPaintProperty).toHaveBeenCalledWith('water-layer', 'raster-opacity', 0.4);
  });

  test('updates a changed tile URL through the existing raster source', () => {
    const map = createMap();
    reconcileRasterLayer(map, {
      layerId: 'water-layer',
      sourceId: 'water',
      tileUrl: 'https://tiles/one',
    });
    const source = map.getSource('water');
    map.addSource.mockClear();

    const result = reconcileRasterLayer(map, {
      layerId: 'water-layer',
      sourceId: 'water',
      tileUrl: 'https://tiles/two',
      previousTileUrl: 'https://tiles/one',
    });

    expect(result).toEqual({ sourceChanged: true, status: 'updated' });
    expect(source.setTiles).toHaveBeenCalledWith(['https://tiles/two']);
    expect(map.addSource).not.toHaveBeenCalled();
  });
});
