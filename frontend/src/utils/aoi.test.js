import {
  buildAoiFromGridSelection,
  buildAoiFromAgentState,
  buildAoiFromGeoJSON,
  buildAoiFromDrawFeatures,
  isFishnetAoi,
  resolveAgentAnalysisAoi,
} from './aoi';

describe('Agent AOI resolution', () => {
  const businessAoi = {
    id: 'uploaded-aoi',
    source: 'upload',
    bounds: { west: 1, south: 2, east: 3, north: 4 },
  };

  test('identifies fishnet AOIs case-insensitively', () => {
    expect(isFishnetAoi({ source: 'fishnet' })).toBe(true);
    expect(isFishnetAoi({ source: 'FISHNET' })).toBe(true);
    expect(isFishnetAoi(businessAoi)).toBe(false);
  });

  test('never resolves a fishnet selection as an Agent analysis AOI', () => {
    const fishnetAoi = buildAoiFromGridSelection([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);

    expect(resolveAgentAnalysisAoi(fishnetAoi)).toBeNull();
  });

  test('falls through a fishnet candidate to the first visible analysis AOI', () => {
    const fishnetAoi = { id: 'grid-aoi', source: 'fishnet' };

    expect(resolveAgentAnalysisAoi(fishnetAoi, null, businessAoi)).toBe(businessAoi);
  });

  test('recovers missing bounds and map center from an existing confirmed boundary', () => {
    const confirmed = {
      id: 'rasuwa', source: 'official_boundary', label: 'Rasuwa, Nepal', bounds: null,
      geojson: { type: 'Feature', geometry: {
        type: 'Polygon', coordinates: [[[85.1, 28], [85.6, 28], [85.6, 28.4], [85.1, 28.4], [85.1, 28]]],
      } },
    };
    const aoi = buildAoiFromAgentState({ confirmed_aoi: confirmed });
    expect(aoi.bounds).toEqual({ west: 85.1, south: 28, east: 85.6, north: 28.4 });
    expect(aoi.center.lng).toBeCloseTo(85.35);
    expect(aoi.center.lat).toBeCloseTo(28.2);
    expect(aoi.id).toBe('rasuwa');
    expect(aoi.geojson).toBe(confirmed.geojson);
    expect(confirmed.bounds).toBeNull();
  });

  test.each([
    ['east and north', 100, 13], ['east and south', 106, -6],
    ['west and north', -74, 40], ['equator', 0, 0],
  ])('upload and draw preserve holes and all parts in %s scopes', (_, west, south) => {
    const ring = [
      [west, south], [west + 1, south], [west + 1, south + 1],
      [west, south + 1], [west, south],
    ];
    const hole = [
      [west + 0.2, south + 0.2], [west + 0.4, south + 0.2],
      [west + 0.4, south + 0.4], [west + 0.2, south + 0.4], [west + 0.2, south + 0.2],
    ];
    const second = ring.map(([lng, lat]) => [lng + 2, lat + 2]);
    const features = [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring, hole] } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [second] } },
    ];
    const uploaded = buildAoiFromGeoJSON({ type: 'FeatureCollection', features });
    const drawn = buildAoiFromDrawFeatures(features);
    for (const aoi of [uploaded, drawn]) {
      const recovered = buildAoiFromAgentState({ confirmed_aoi: { ...aoi, bounds: null, center: null } });
      expect(recovered.bounds).toEqual({ west, south, east: west + 3, north: south + 3 });
      expect(recovered.center).toEqual({ lng: west + 1.5, lat: south + 1.5 });
      expect(recovered.geojson.geometry.type).toBe('MultiPolygon');
      expect(recovered.geojson.geometry.coordinates[0][1]).toEqual(hole);
      expect(recovered.geojson.geometry.coordinates[1][0]).toEqual(second);
    }
  });
});
