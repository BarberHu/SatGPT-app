import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useFloodAgentStateAdapter, { buildFloodAgentViewState } from './useFloodAgentStateAdapter';

function HookHarness({ options, expose }) {
  expose.current = useFloodAgentStateAdapter(options);
  return null;
}

describe('useFloodAgentStateAdapter', () => {
  let container;
  let root;
  let expose;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    expose = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('keeps equivalent AOI and layer references stable across Copilot renders', () => {
    const firstState = {
      event: 'Test flood',
      coordinates: [120, 30],
      bounds: [119, 29, 121, 31],
      confirmed_aoi: { id: 'aoi-1', bounds: [119, 29, 121, 31] },
      recommended_layers: [{ id: 'layer-1', title: 'Layer 1' }],
    };
    act(() => {
      root.render(<HookHarness options={{ state: firstState }} expose={expose} />);
    });
    const firstAoi = expose.current.currentState.confirmed_aoi;
    const firstLayers = expose.current.currentState.recommended_layers;

    act(() => {
      root.render(<HookHarness options={{ state: {
        ...firstState,
        coordinates: [...firstState.coordinates],
        bounds: [...firstState.bounds],
        confirmed_aoi: { ...firstState.confirmed_aoi, bounds: [...firstState.confirmed_aoi.bounds] },
        recommended_layers: firstState.recommended_layers.map((layer) => ({ ...layer })),
      } }} expose={expose} />);
    });

    expect(expose.current.currentState.confirmed_aoi).toBe(firstAoi);
    expect(expose.current.currentState.recommended_layers).toBe(firstLayers);
  });

  test('publishes a view projection without conversation-only fields', () => {
    const viewState = buildFloodAgentViewState({
      event: 'Conversation event',
      flood_report: 'Conversation report',
      pre_date: '2024-01-01',
      peek_date: '2024-01-02',
      after_date: '2024-01-03',
      location: 'Nanjing',
      coordinates: [118.8, 32.1],
      bounds: null,
      geojson: null,
      resolved_aoi: null,
      aoi_resolution_meta: null,
      confirmed_aoi: null,
      recommended_layers: [],
      selected_layer_ids: [],
      recommendation_strategy: null,
      recommendation_source: null,
      confirmation_version: 1,
    });

    expect(viewState.event).toBeUndefined();
    expect(viewState.flood_report).toBeUndefined();
    expect(viewState.pre_date).toBeUndefined();
    expect(viewState.location).toBe('Nanjing');
  });
});
