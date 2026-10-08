import { canStartFloodAnalysis, hasRawToolMarkup, hasValidFloodDates, summarizeFloodImagery } from './floodWorkflow';

const candidate = {
  event: 'Nepal flood', location: 'Rasuwa District, Nepal',
  pre_date: '2026-08-19', peek_date: '2026-08-26', after_date: '2026-09-02',
};

describe('flood workflow contract', () => {
  test('waits for explicit confirmation even with a complete candidate and AOI', () => {
    expect(canStartFloodAnalysis(candidate, { id: 'rasuwa' })).toBe(false);
    expect(canStartFloodAnalysis({ ...candidate, user_confirmed: true }, { id: 'rasuwa' })).toBe(true);
    expect(canStartFloodAnalysis({ ...candidate, user_confirmed: true }, null)).toBe(false);
    expect(canStartFloodAnalysis({ ...candidate, user_confirmed: false }, { id: 'rasuwa' })).toBe(false);
  });

  test('rejects impossible, incomplete, and reversed dates', () => {
    expect(hasValidFloodDates(candidate)).toBe(true);
    expect(hasValidFloodDates({ ...candidate, peek_date: '2026-02-30' })).toBe(false);
    expect(hasValidFloodDates({ ...candidate, pre_date: '2026-09-10' })).toBe(false);
    expect(hasValidFloodDates({ ...candidate, after_date: null })).toBe(false);
    expect(hasValidFloodDates({ ...candidate, after_date: '2026-9-02' })).toBe(false);
  });

  test('blocks guessed search scopes even after they have been imported', () => {
    const state = { ...candidate, user_confirmed: true };
    expect(canStartFloodAnalysis(state, { source: 'bounds_fallback' })).toBe(false);
    expect(canStartFloodAnalysis(state, { source: 'place_search', boundary_source: 'approximate_boundary' })).toBe(false);
    expect(canStartFloodAnalysis(state, { source: 'place_search', status: 'Approximate boundary' })).toBe(false);
    expect(canStartFloodAnalysis(state, { source: 'place_search', can_analyze: false })).toBe(false);
    expect(canStartFloodAnalysis(state, { source: 'draw', geojson: { properties: {} } })).toBe(true);
  });

  test('detects provider tool markup, including partial streamed output', () => {
    expect(hasRawToolMarkup('<｜DSML｜tool_calls>')).toBe(true);
    expect(hasRawToolMarkup('<|DSML|')).toBe(true);
    expect(hasRawToolMarkup('Please confirm the event.')).toBe(false);
    expect(hasRawToolMarkup(JSON.stringify(candidate))).toBe(false);
  });

  test('distinguishes available tiles from errors inside a successful response', () => {
    expect(summarizeFloodImagery({ peek_date: { sentinel1: { tile_url: 'sar-tile' } } }))
      .toEqual({ hasTiles: true, warning: '' });
    const unavailable = summarizeFloodImagery({
      peek_date: { sentinel1: { error: 'No Sentinel-1 imagery found' } },
      flood_detection: { error: 'Insufficient SAR imagery for change detection' },
    });
    expect(unavailable.hasTiles).toBe(false);
    expect(unavailable.warning).toContain('No displayable imagery');
    expect(unavailable.warning).toContain('Insufficient SAR imagery');
    const partial = summarizeFloodImagery({
      custom_range: { sentinel2: { tile_url: 'optical-tile' }, sentinel1: { error: 'No SAR imagery in window' } },
    });
    expect(partial.hasTiles).toBe(true);
    expect(partial.warning).toContain('Some imagery layers are unavailable');
    expect(summarizeFloodImagery({ error: 'GeoJSON processing failed' }).warning).toContain('GeoJSON processing failed');
    expect(summarizeFloodImagery({}).warning).toContain('No displayable imagery');
  });
});
