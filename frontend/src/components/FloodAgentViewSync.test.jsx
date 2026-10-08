import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import FloodAgentViewSync from './FloodAgentViewSync';
import { getFloodImages } from '../services/agentApi';
import { buildAoiSignature } from '../utils/aoi';

const fixture = vi.hoisted(() => ({ state: {}, context: {} }));
vi.mock('@copilotkit/react-core', () => ({ useCoAgent: () => ({ state: fixture.state }) }));
vi.mock('../context/AppContext', () => ({ useAppContext: () => fixture.context }));
vi.mock('../services/agentApi', () => ({ getFloodImages: vi.fn(), getFloodImpact: vi.fn() }));
vi.mock('../utils/analytics', () => ({ trackUxEvent: vi.fn() }));
vi.mock('../utils/agentDiagnostics', () => ({ startAgentDiagnosticSpan: () => vi.fn() }));

const bounds = { west: 85.1, south: 28, east: 85.6, north: 28.4 };
const confirmedState = () => ({
  event: 'Flood event', location: 'Test region', user_confirmed: true, stage: 'completed',
  pre_date: '2026-08-19', peek_date: '2026-08-26', after_date: '2026-09-02',
  confirmed_aoi: { id: 'scope-a', source: 'official_boundary', bounds,
    geojson: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [
      [[85.1, 28], [85.6, 28], [85.6, 28.4], [85.1, 28.4], [85.1, 28]],
    ] } } },
  selected_layer_ids: ['core:flood_detection'],
});

describe('persistent flood analysis subscription', () => {
  let root;
  let resolveImages;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    fixture.state = confirmedState();
    fixture.context = {
      agentModule: 'flood', agentAnalysisContext: {}, selectedAOI: null,
      agentImpactData: null, agentImpactLoading: false,
      setAgentAnalysisContext: vi.fn(), setAgentImagery: vi.fn(),
      setAgentFloodImageryLoading: vi.fn(), setAgentImpactData: vi.fn(),
      setAgentImpactLoading: vi.fn(), setAgentTileError: vi.fn(), setWarning: vi.fn(),
      setAgentShowFloodDetection: vi.fn(), setAgentShowPopulationLayer: vi.fn(),
      setAgentShowUrbanLayer: vi.fn(), setAgentShowLandcoverLayer: vi.fn(),
    };
    getFloodImages.mockImplementation(() => new Promise(resolve => { resolveImages = resolve; }));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('keeps the same request running when switching Flood to Imagery and back', async () => {
    await act(async () => root.render(<FloodAgentViewSync />));
    const signal = getFloodImages.mock.calls[0][1].signal;
    fixture.context = { ...fixture.context, agentModule: 'imagery' };
    await act(async () => root.render(<FloodAgentViewSync />));
    expect(signal.aborted).toBe(false);
    expect(getFloodImages).toHaveBeenCalledTimes(1);
    await act(async () => resolveImages({ success: true, data: { flood_detection: { tile_url: 'flood' } } }));
    const result = fixture.context.setAgentImagery.mock.calls.at(-1)[0](null);
    expect(result.flood_detection.tile_url).toBe('flood');
    expect(result.imagery_aoi_signature).toBe(buildAoiSignature(fixture.state.confirmed_aoi));
    fixture.context = { ...fixture.context, agentModule: 'flood' };
    await act(async () => root.render(<FloodAgentViewSync />));
    expect(getFloodImages).toHaveBeenCalledTimes(1);
    expect(fixture.context.setAgentFloodImageryLoading).toHaveBeenLastCalledWith(false);
  });

  test('starts confirmed analysis even when Imagery is the active panel', async () => {
    fixture.context.agentModule = 'imagery';
    await act(async () => root.render(<FloodAgentViewSync />));
    expect(getFloodImages).toHaveBeenCalledTimes(1);
    expect(fixture.context.setAgentShowFloodDetection).toHaveBeenLastCalledWith(true);
    expect(fixture.context.setAgentAnalysisContext).toHaveBeenLastCalledWith(expect.objectContaining({
      user_confirmed: true, pre_date: '2026-08-19', after_date: '2026-09-02',
    }));
  });

  test('cancels the old request on an AOI change and rejects its late response', async () => {
    await act(async () => root.render(<FloodAgentViewSync />));
    const signal = getFloodImages.mock.calls[0][1].signal;
    fixture.context.selectedAOI = { id: 'scope-b', source: 'upload', bounds };
    await act(async () => root.render(<FloodAgentViewSync />));
    expect(signal.aborted).toBe(true);
    fixture.context.setAgentImagery.mockClear();
    await act(async () => resolveImages({ success: true, data: { flood_detection: { tile_url: 'old' } } }));
    expect(fixture.context.setAgentImagery).not.toHaveBeenCalled();
    expect(fixture.context.setAgentShowFloodDetection).toHaveBeenLastCalledWith(false);
  });

  test('does not fetch imagery for an unconfirmed candidate', async () => {
    fixture.state = { ...fixture.state, user_confirmed: false };
    await act(async () => root.render(<FloodAgentViewSync />));
    expect(getFloodImages).not.toHaveBeenCalled();
    expect(fixture.context.setAgentShowFloodDetection).toHaveBeenLastCalledWith(false);
  });
});
