import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getAgentRasterLayers } from '../services/api';
import useAgentRasterLayerRequest from './useAgentRasterLayerRequest';

jest.mock('../services/api', () => ({
  getAgentRasterLayers: jest.fn(),
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
  expose.current = useAgentRasterLayerRequest(options);
  return null;
}

describe('useAgentRasterLayerRequest', () => {
  let container;
  let root;
  let expose;
  let options;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    expose = { current: null };
    options = {
      aoiSignature: 'aoi-1',
      mergeLayerData: jest.fn(),
      setAgentLayerLoading: jest.fn(),
      setWarning: jest.fn(),
    };
    act(() => {
      root.render(<HookHarness options={options} expose={expose} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    delete global.IS_REACT_ACT_ENVIRONMENT;
    jest.clearAllMocks();
  });

  test('ignores an older response for the same layer', async () => {
    const first = deferred();
    const second = deferred();
    getAgentRasterLayers
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstRequest = expose.current({
      layerKey: 'inundationHotspot',
      params: { layer_keys: ['inundationHotspot'] },
      requestKey: 'old-request',
    });
    const secondRequest = expose.current({
      layerKey: 'inundationHotspot',
      params: { layer_keys: ['inundationHotspot'] },
      requestKey: 'new-request',
    });

    expect(getAgentRasterLayers.mock.calls[0][1].signal.aborted).toBe(true);
    expect(getAgentRasterLayers.mock.calls[1][1].signal.aborted).toBe(false);

    first.resolve({ eeMapURLInundationHotspot: 'old' });
    await firstRequest;
    expect(options.mergeLayerData).not.toHaveBeenCalled();

    second.resolve({ eeMapURLInundationHotspot: 'new' });
    await secondRequest;
    expect(options.mergeLayerData).toHaveBeenCalledTimes(1);
    expect(options.mergeLayerData).toHaveBeenCalledWith(
      { eeMapURLInundationHotspot: 'new' },
      { aoiSignature: 'aoi-1', requestKey: 'new-request' }
    );
  });

  test('tracks concurrent loading independently for each layer', async () => {
    const first = deferred();
    const second = deferred();
    let loadingState = {};
    options.setAgentLayerLoading.mockImplementation((update) => {
      loadingState = update(loadingState);
    });
    getAgentRasterLayers
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstRequest = expose.current({
      layerKey: 'wildfireRisk',
      params: { layer_keys: ['wildfireRisk'] },
      requestKey: 'wildfire-request',
    });
    const secondRequest = expose.current({
      layerKey: 'burnHistory',
      params: { layer_keys: ['burnHistory'] },
      requestKey: 'burn-request',
    });

    first.resolve({ eeMapURLWildfireRisk: 'wildfire' });
    await firstRequest;
    expect(loadingState).toEqual({
      'raster-burnHistory': true,
      'raster-wildfireRisk': false,
    });

    second.resolve({ eeMapURLBurnHistory: 'burn' });
    await secondRequest;
    expect(loadingState).toEqual({
      'raster-burnHistory': false,
      'raster-wildfireRisk': false,
    });
  });

  test('ignores a response after the selected AOI changes', async () => {
    const request = deferred();
    getAgentRasterLayers.mockReturnValueOnce(request.promise);
    const pendingRequest = expose.current({
      layerKey: 'slopeSteepness',
      params: { layer_keys: ['slopeSteepness'] },
      requestKey: 'aoi-1-request',
    });

    act(() => {
      root.render(<HookHarness options={{ ...options, aoiSignature: 'aoi-2' }} expose={expose} />);
    });
    request.resolve({ eeMapURLSlopeSteepness: 'stale' });
    await pendingRequest;

    expect(options.mergeLayerData).not.toHaveBeenCalled();
    expect(options.setWarning).not.toHaveBeenCalled();
  });
});
