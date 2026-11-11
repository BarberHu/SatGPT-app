import {
  buildAoiFromGridSelection,
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
});
