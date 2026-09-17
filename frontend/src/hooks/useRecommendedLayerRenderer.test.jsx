import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderRecommendedLayer } from '../services/agentApi';
import { startAgentDiagnosticSpan } from '../utils/agentDiagnostics';
import useRecommendedLayerRenderer from './useRecommendedLayerRenderer';

vi.mock('../services/agentApi', () => ({ renderRecommendedLayer: vi.fn() }));
vi.mock('../utils/agentDiagnostics', () => ({
  startAgentDiagnosticSpan: vi.fn(() => vi.fn()),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

function HookHarness({ options }) {
  useRecommendedLayerRenderer(options);
  return null;
}

describe('useRecommendedLayerRenderer', () => {
  let container;
  let root;
  let requests;
  let loadingState;
  let options;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    requests = [deferred(), deferred(), deferred()];
    startAgentDiagnosticSpan.mockImplementation(() => vi.fn());
    renderRecommendedLayer
      .mockReturnValueOnce(requests[0].promise)
      .mockReturnValueOnce(requests[1].promise)
      .mockReturnValueOnce(requests[2].promise);
    loadingState = {};
    options = {
      agentRecommendedLayerData: {},
      agentRecommendedLayerVisibility: { one: true, two: true, three: true },
      canRenderCatalogLayer: () => true,
      catalogRenderAoi: { id: 'aoi-1' },
      controlPanelCatalogLayers: [
        { id: 'one', title: 'One' },
        { id: 'two', title: 'Two' },
        { id: 'three', title: 'Three' },
      ],
      currentAfterDate: '2024-01-03',
      currentPeekDate: '2024-01-02',
      currentPreDate: '2024-01-01',
      getCatalogLayerDateWindow: () => ({ start_date: '2024-01-01', end_date: '2024-01-03' }),
      getRecommendedLayerContextKey: (layer) => `context:${layer.id}`,
      recommendedLayerBaseContextKey: 'context',
      setAgentLayerLoading: vi.fn((update) => { loadingState = update(loadingState); }),
      setAgentRecommendedLayerData: vi.fn((update) => {
        if (typeof update === 'function') update({});
      }),
      setWarning: vi.fn(),
    };
  });

  afterEach(() => {
    if (container) act(() => root.unmount());
    vi.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('limits render concurrency and aborts active requests on unmount', async () => {
    await act(async () => {
      root.render(<HookHarness options={options} />);
      await Promise.resolve();
    });
    expect(renderRecommendedLayer).toHaveBeenCalledTimes(2);

    const firstSignal = renderRecommendedLayer.mock.calls[0][1].signal;
    const secondSignal = renderRecommendedLayer.mock.calls[1][1].signal;
    act(() => root.unmount());
    container = null;

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    expect(loadingState).toEqual({ one: false, two: false });
  });
});
