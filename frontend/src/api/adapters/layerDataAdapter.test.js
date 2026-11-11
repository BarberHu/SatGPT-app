import { createEmptyLayerData, normalizeLayerData } from './layerDataAdapter';

test('empty layer data exposes only canonical layer names', () => {
  const emptyLayerData = createEmptyLayerData();

  expect(emptyLayerData.populationDensity).toBeNull();
  expect(emptyLayerData.lclu).toBeNull();
  expect(emptyLayerData).not.toHaveProperty('populationExposure');
  expect(emptyLayerData).not.toHaveProperty('fuelLandCover');
});

test('partial normalization updates only fields returned by the API', () => {
  const normalized = normalizeLayerData({
    eeMapIdInundationHotspot: 'map-id',
    eeTokenInundationHotspot: 'token',
    eeMapURLInundationHotspot: 'https://tiles/{z}/{x}/{y}',
    inundationHotspotMeta: { year_start: 2018 },
  }, {
    partial: true,
    aoiSignature: 'aoi-1',
    requestKey: 'request-1',
  });

  expect(normalized).toEqual({
    inundationHotspot: {
      mapId: 'map-id',
      token: 'token',
      tileUrl: 'https://tiles/{z}/{x}/{y}',
      meta: { year_start: 2018 },
      aoiSignature: 'aoi-1',
      requestKey: 'request-1',
    },
  });
});
