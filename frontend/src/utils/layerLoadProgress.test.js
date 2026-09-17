import {
  buildTileEventKey,
  calculateTileLoadPercent,
  TILE_PROGRESS_CEILING,
  TILE_PROGRESS_START,
} from './layerLoadProgress';

describe('layerLoadProgress', () => {
  test('builds a stable key from Mapbox tile coordinates', () => {
    expect(buildTileEventKey({
      coord: {
        wrap: 1,
        overscaledZ: 8,
        canonical: { z: 7, x: 103, y: 52 },
      },
    })).toBe('7/103/52@1');
  });

  test('falls back to the tile payload used by Mapbox error events', () => {
    expect(buildTileEventKey({
      tile: { tileID: { canonical: { z: 5, x: 20, y: 11 } } },
    })).toBe('5/20/11@0');
  });

  test('uses a measured, monotonic percentage before idle completion', () => {
    const first = calculateTileLoadPercent({ requestedTiles: 4, settledTiles: 1 });
    expect(first).toBeGreaterThan(TILE_PROGRESS_START);

    const withNewRequests = calculateTileLoadPercent({
      requestedTiles: 12,
      settledTiles: 1,
      previousPercent: first,
    });
    expect(withNewRequests).toBe(first);

    const allObservedTilesSettled = calculateTileLoadPercent({
      requestedTiles: 12,
      settledTiles: 12,
      previousPercent: withNewRequests,
    });
    expect(allObservedTilesSettled).toBe(TILE_PROGRESS_CEILING);
    expect(calculateTileLoadPercent({ complete: true })).toBe(100);
  });
});
