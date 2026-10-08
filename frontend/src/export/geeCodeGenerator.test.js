import { createCodeSnippet } from './geeCodeGenerator';

const aoi = JSON.stringify({
  source: 'test',
  geojson: {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[100, 10], [101, 10], [101, 11], [100, 11], [100, 10]]],
    },
  },
});

describe('createCodeSnippet', () => {
  test('generates the historical export independently from the API transport', () => {
    const code = createCodeSnippet({
      aoi,
      coordinates: '[]',
      time_start: '2010-01-01',
      time_end: '2020-12-31',
    }, 'historical');

    expect(code).toContain('ee.Geometry.Polygon');
    expect(code).toContain('JRC/GSW1_4/YearlyHistory');
    expect(code).toContain("var time_start = '2010-01-01'");
  });

  test('generates the hotspot frequency window', () => {
    const code = createCodeSnippet({
      aoi,
      coordinates: '[]',
      time_start: '2010-01-01',
      time_end: '2014-12-31',
      year_from: 2010,
      year_count: 5,
    }, 'flood_hotspot');

    expect(code).toContain('var year_from = 2010;');
    expect(code).toContain('var year_count = 5;');
    expect(code).toContain('var floodFrequency = yearsWithWater.divide(year_count);');
  });

  test('returns no export when no AOI can be resolved', () => {
    expect(createCodeSnippet({ coordinates: '[]' }, 'historical')).toBe('');
  });

  test.each(['historical', 'flood_hotspot'])('exports the complete annual record for %s', (dataType) => {
    const code = createCodeSnippet({
      aoi, time_start: '2022-01-01', time_end: '2024-12-31',
      year_start: 2022, year_end: 2024,
    }, dataType);
    expect(() => new Function('ee', 'Map', code)).not.toThrow();
    expect(code).toContain("calendarRange(1984, 2015, 'year')");
    expect(code).toContain('GSW1_5/YearlyHistory_2016_2021');
    expect(code).toContain('GSW1_5/YearlyHistory_2022_2024');
  });
});
