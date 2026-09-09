import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getFloodImages, getFloodImpact } from '../services/agentApi';
import { startAgentDiagnosticSpan } from '../utils/agentDiagnostics';
import useFloodAnalysisRequests from './useFloodAnalysisRequests';

vi.mock('../services/agentApi', () => ({
  getFloodImages: vi.fn(),
  getFloodImpact: vi.fn(),
}));
vi.mock('../utils/analytics', () => ({ trackUxEvent: vi.fn() }));
vi.mock('../utils/agentDiagnostics', () => ({
  startAgentDiagnosticSpan: vi.fn(() => vi.fn()),
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

function HookHarness({ options, expose }) {
  expose.current = useFloodAnalysisRequests(options);
  return null;
}

const createOptions = (overrides = {}) => ({
  analysisDisplayEnabled: false,
  currentAfterDate: '2024-01-03',
  currentBounds: [119, 29, 121, 31],
  currentCoordinates: [120, 30],
  currentGeojson: null,
  currentPeekDate: '2024-01-02',
  currentPreDate: '2024-01-01',
  effectiveAoi: { id: 'aoi-1', bounds: [119, 29, 121, 31], source: 'agent' },
  effectiveAoiSignature: 'aoi-1',
  impactLayerVisible: false,
  agentImpactData: null,
  agentImpactLoading: false,
  setAgentImagery: vi.fn(),
  setAgentImageryLoading: vi.fn(),
  setAgentImpactData: vi.fn(),
  setAgentImpactLoading: vi.fn(),
  setAgentTileError: vi.fn(),
  setWarning: vi.fn(),
  ...overrides,
});

describe('useFloodAnalysisRequests', () => {
  let container;
  let root;
  let expose;
  let options;
  let consoleError;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    expose = { current: null };
    options = createOptions();
    startAgentDiagnosticSpan.mockImplementation(() => vi.fn());
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => root.render(<HookHarness options={options} expose={expose} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    consoleError.mockRestore();
    vi.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('releases a failed imagery request so the same request can retry', async () => {
    getFloodImages
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ success: true, data: { flood_detection: 'tile' } });
    const requestState = {
      pre_date: options.currentPreDate,
      peek_date: options.currentPeekDate,
      after_date: options.currentAfterDate,
      coordinates: options.currentCoordinates,
      bounds: options.currentBounds,
    };

    await act(async () => expose.current.fetchAgentImagery(requestState, options.effectiveAoi));
    await act(async () => expose.current.fetchAgentImagery(requestState, options.effectiveAoi));

    expect(getFloodImages).toHaveBeenCalledTimes(2);
    expect(options.setAgentImageryLoading.mock.calls.map(([value]) => value)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(options.setAgentImagery).toHaveBeenLastCalledWith({ flood_detection: 'tile' });
  });

  test('aborts imagery and impact requests when the analysis context becomes inactive', async () => {
    const imagery = deferred();
    const impact = deferred();
    getFloodImages.mockReturnValue(imagery.promise);
    getFloodImpact.mockReturnValue(impact.promise);
    const activeOptions = createOptions({ analysisDisplayEnabled: true, impactLayerVisible: true });

    await act(async () => {
      root.render(<HookHarness options={activeOptions} expose={expose} />);
      await Promise.resolve();
    });
    const imagerySignal = getFloodImages.mock.calls[0][1].signal;
    await act(async () => expose.current.fetchImpactData());
    const impactSignal = getFloodImpact.mock.calls[0][1].signal;

    act(() => root.render(<HookHarness options={{ ...activeOptions, analysisDisplayEnabled: false }} expose={expose} />));

    expect(imagerySignal.aborted).toBe(true);
    expect(impactSignal.aborted).toBe(true);
  });
});
