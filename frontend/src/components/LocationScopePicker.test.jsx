import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LocationScopePicker from './LocationScopePicker';
import { searchLocationCandidates } from '../services/agentApi';

const fixture = vi.hoisted(() => ({ context: {} }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => fixture.context }));
vi.mock('../services/agentApi', () => ({ searchLocationCandidates: vi.fn() }));

const geometry = { type: 'Polygon', coordinates: [
  [[100.33, 13.50], [100.94, 13.50], [100.94, 13.96], [100.33, 13.96], [100.33, 13.50]],
] };
const candidate = {
  id: 'reference:THA:ADM1:Bangkok:2017', label: 'Bangkok, Thailand',
  source: 'reference_boundary', raw_type: 'administrative',
  source_label: 'Royal Thai Survey Department / HDX · 2017',
  boundary_notice: 'City boundary, excluding offshore waters; 2017 reference data.',
  resolved_aoi: {
    label: 'Bangkok, Thailand', source: 'reference_boundary', boundary_year: '2017',
    bounds: { west: 100.33, south: 13.50, east: 100.94, north: 13.96 },
    geojson: { type: 'Feature', properties: { boundary_year: '2017' }, geometry },
  },
};

describe('place search reference boundaries', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fixture.context = {
      selectedAOI: null, setSelectedAOI: vi.fn(),
      registerBusinessLayerFromAoi: vi.fn(), setBusinessLayerActive: vi.fn(),
      clearAgentVisualState: vi.fn(), setWarning: vi.fn(),
      agentAnalysisContext: {}, appMode: 'agent',
      mapInstance: { fitBounds: vi.fn() },
    };
    searchLocationCandidates.mockResolvedValue({ data: [candidate] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  async function search(query = 'bangkok') {
    await act(async () => root.render(<LocationScopePicker embedded />));
    const input = container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('[aria-label="Search places"]').click());
  }

  test('shows the source, historical year and offshore exclusion before adding', async () => {
    await search();
    expect(container.textContent).toContain('Royal Thai Survey Department / HDX · 2017');
    expect(container.textContent).toContain('excluding offshore waters');
    expect(container.textContent).not.toContain('official_boundary');
    expect(searchLocationCandidates.mock.calls[0][0]).toEqual({ query: 'bangkok', limit: 5 });
  });

  test('previews and imports the same geometry, bounds and provenance', async () => {
    await search();
    const preview = fixture.context.setSelectedAOI.mock.calls.at(-1)[0];
    expect(preview.geojson.geometry).toEqual(geometry);
    expect(preview.bounds.south).toBe(13.50);
    expect(fixture.context.mapInstance.fitBounds.mock.calls[0][0]).toEqual([
      [100.33, 13.50], [100.94, 13.96],
    ]);
    await act(async () => container.querySelector('input[type="checkbox"]').click());
    await act(async () => container.querySelector('.location-scope-picker-action.primary').click());
    const imported = fixture.context.registerBusinessLayerFromAoi.mock.calls[0][0];
    expect(imported.geojson.geometry).toEqual(preview.geojson.geometry);
    expect(imported.bounds).toEqual(preview.bounds);
    expect(imported.boundary_year).toBe('2017');
    expect(imported.geojson.properties.boundary_year).toBe('2017');
    expect(fixture.context.setSelectedAOI.mock.calls.at(-1)[0]).toEqual(imported);
  });

  test('labels ordinary geocoder results OpenStreetMap instead of official', async () => {
    searchLocationCandidates.mockResolvedValue({ data: [{
      ...candidate, source: 'osm_boundary', source_label: undefined, boundary_notice: undefined,
    }] });
    await search('another city');
    expect(container.textContent).toContain('OpenStreetMap boundary');
    expect(container.textContent).not.toContain('official');
  });

  test('multiple city/province matches require selection and keep the full scope label', async () => {
    const province = { ...candidate, id: 'province', label: 'Chiang Mai Province, Thailand',
      boundary_kind: 'state', admin_level: '4', resolved_aoi: { ...candidate.resolved_aoi, label: 'Chiang Mai Province, Thailand' } };
    const city = { ...candidate, id: 'city', label: 'Chiang Mai City Municipality, Thailand',
      boundary_kind: 'city', admin_level: '8' };
    searchLocationCandidates.mockResolvedValue({ data: [city, province] });
    await search('Chiang Mai');
    expect(container.textContent).toContain('Multiple administrative regions match');
    expect(container.textContent).toContain('admin level 4');
    expect(fixture.context.setSelectedAOI).not.toHaveBeenCalled();
    await act(async () => container.querySelectorAll('input[type="checkbox"]')[1].click());
    expect(fixture.context.setSelectedAOI.mock.calls.at(-1)[0].label).toBe(province.label);
    await act(async () => container.querySelector('.location-scope-picker-action.primary').click());
    expect(fixture.context.registerBusinessLayerFromAoi.mock.calls[0][0].label).toBe(province.label);
    expect(fixture.context.registerBusinessLayerFromAoi.mock.calls[0][0].boundary_source).toBe('reference_boundary');
  });

  test('old approximate candidates cannot be previewed or imported', async () => {
    searchLocationCandidates.mockResolvedValue({ data: [{ ...candidate,
      resolved_aoi: { ...candidate.resolved_aoi, source: 'bounds_fallback', status: 'Approximate boundary' },
    }] });
    await search();
    expect(fixture.context.setSelectedAOI).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="checkbox"]').disabled).toBe(true);
    expect(container.querySelector('.location-scope-picker-action.primary').disabled).toBe(true);
  });

  test('a stale search response cannot restore the earlier boundary', async () => {
    let finishFirst;
    searchLocationCandidates.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    await search('first');
    const input = container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'second');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Submit after React has committed the changed query.
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => finishFirst({ data: [{ ...candidate, label: 'Stale boundary' }] }));
    expect(container.textContent).not.toContain('Stale boundary');
    expect(fixture.context.setSelectedAOI.mock.calls.at(-1)[0].label).toBe('Bangkok, Thailand');
  });
});
