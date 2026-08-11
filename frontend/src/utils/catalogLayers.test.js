import { shouldReuseCatalogMapLayer } from './catalogLayers';

describe('shouldReuseCatalogMapLayer', () => {
  test('keeps an already-mounted sibling source when its descriptor is unchanged', () => {
    expect(shouldReuseCatalogMapLayer({
      previousSignature: 'hls-context|hls-tile-url',
      nextSignature: 'hls-context|hls-tile-url',
      hasLayer: true,
      hasSource: true,
    })).toBe(true);
  });

  test.each([
    ['the descriptor changed', 'old-context|tile', 'new-context|tile', true, true],
    ['the map layer is missing', 'context|tile', 'context|tile', false, true],
    ['the map source is missing', 'context|tile', 'context|tile', true, false],
  ])('rebuilds when %s', (_label, previousSignature, nextSignature, hasLayer, hasSource) => {
    expect(shouldReuseCatalogMapLayer({
      previousSignature,
      nextSignature,
      hasLayer,
      hasSource,
    })).toBe(false);
  });
});
