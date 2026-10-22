import { buildCatalogLayerContextKey } from './catalogLayerContext';

describe('catalogLayerContext', () => {
  const baseContextKey = 'event|aoi|catalog';
  const sentinel1 = { id: 'dynamic-surface-water-sentinel-1' };
  const hls = { id: 'dynamic-surface-water-hls' };
  const hlsWindow = {
    mode: 'date_range',
    start_date: '2026-07-02',
    end_date: '2026-08-04',
  };

  test('changing one layer window does not invalidate its sibling key', () => {
    const sentinel1Before = buildCatalogLayerContextKey({
      baseContextKey,
      layer: sentinel1,
      dateWindow: {
        mode: 'date_range',
        start_date: '2026-07-02',
        end_date: '2026-08-04',
      },
    });
    const sentinel1After = buildCatalogLayerContextKey({
      baseContextKey,
      layer: sentinel1,
      dateWindow: {
        mode: 'date_range',
        start_date: '2026-07-06',
        end_date: '2026-08-04',
      },
    });
    const hlsBefore = buildCatalogLayerContextKey({
      baseContextKey,
      layer: hls,
      dateWindow: hlsWindow,
    });
    const hlsAfter = buildCatalogLayerContextKey({
      baseContextKey,
      layer: hls,
      dateWindow: hlsWindow,
    });

    expect(sentinel1After).not.toBe(sentinel1Before);
    expect(hlsAfter).toBe(hlsBefore);
    expect(sentinel1After).not.toBe(hlsAfter);
  });
});
