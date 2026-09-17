import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAoiSignature } from '../utils/aoi';
import DisasterLayerPanel from './DisasterLayerPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
  context: null,
  layerManagerProps: null,
}));

vi.mock('../context/AppContext', () => ({
  useAppContext: () => testState.context,
}));

vi.mock('../services/agentApi', () => ({
  getFloodImages: vi.fn(),
}));

vi.mock('../hooks/useAgentRasterDownload', () => ({
  default: () => ({ downloadState: {}, downloadRaster: vi.fn() }),
}));

vi.mock('../hooks/useAgentRasterLayerRequest', () => ({
  default: () => vi.fn(),
}));

vi.mock('./LayerManager', () => ({
  default: (props) => {
    testState.layerManagerProps = props;
    return <div data-testid="layer-manager" />;
  },
}));

const aoiA = {
  id: 'scope-a',
  source: 'upload',
  label: 'Scope A',
  bounds: { west: 118.6, south: 31.8, east: 118.8, north: 32.0 },
  geojson: {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[[118.6, 31.8], [118.8, 31.8], [118.8, 32], [118.6, 32], [118.6, 31.8]]],
    },
  },
};

const aoiB = {
  ...aoiA,
  id: 'scope-b',
  label: 'Scope B',
  bounds: { west: 119.0, south: 32.1, east: 119.2, north: 32.3 },
};

const createContext = (overrides = {}) => ({
  selectedAOI: aoiA,
  layerData: {},
  agentRasterLayerVisibility: {},
  setAgentRasterLayerVisibility: vi.fn(),
  setAgentRasterExpectedRequestKeys: vi.fn(),
  agentLayerLoading: {},
  setAgentLayerLoading: vi.fn(),
  agentLayerProgress: {},
  mergeLayerData: vi.fn(),
  setWarning: vi.fn(),
  agentAnalysisContext: {},
  agentImagery: {
    imagery_aoi_signature: buildAoiSignature(aoiA),
    imagery_window: { start_date: '2024-07-01', end_date: '2024-07-15' },
    custom_range: {},
  },
  setAgentImagery: vi.fn(),
  agentImageryLoading: false,
  setAgentImageryLoading: vi.fn(),
  agentImageryDateWindow: { start_date: '2024-07-01', end_date: '2024-07-15' },
  setAgentImageryDateWindow: vi.fn(),
  setAgentSelectedPeriod: vi.fn(),
  setAgentSelectedType: vi.fn(),
  agentShowBaseImagery: false,
  setAgentShowBaseImagery: vi.fn(),
  agentBaseImageryVisibility: { sentinel2: false, sentinel1: false },
  setAgentBaseImageryVisibility: vi.fn(),
  businessLayers: [
    { ...aoiA, is_active: true, is_visible: true },
    { ...aoiB, is_active: false, is_visible: false },
  ],
  toggleBusinessLayerVisibility: vi.fn(),
  activateBusinessLayerRecord: vi.fn(),
  deleteBusinessLayer: vi.fn(),
  agentLayerOrder: [],
  setAgentLayerOrder: vi.fn(),
  ...overrides,
});

describe('DisasterLayerPanel AOI switching', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    testState.layerManagerProps = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderPanel = () => act(() => root.render(
    <DisasterLayerPanel
      moduleName="imagery"
      moduleLabel="Imagery"
      rasterLayerConfig={[]}
      showRaster={false}
      showImagery
      showVector
    />
  ));

  test('activates a stored vector when it is made visible', () => {
    testState.context = createContext();
    renderPanel();

    const vectorGroup = testState.layerManagerProps.groups.find((group) => group.key === 'vector');
    const scopeB = vectorGroup.items.find((item) => item.title === 'Scope B');
    act(() => scopeB.onToggle({ target: { checked: true } }));

    expect(testState.context.toggleBusinessLayerVisibility).toHaveBeenCalledWith('scope-b');
    expect(testState.context.activateBusinessLayerRecord).toHaveBeenCalledWith('scope-b');
  });

  test('clears imagery belonging to the previous AOI after the active scope changes', () => {
    testState.context = createContext();
    renderPanel();
    testState.context.setAgentImagery.mockClear();
    testState.context.setAgentImageryLoading.mockClear();

    testState.context = createContext({
      selectedAOI: aoiB,
      setAgentImagery: testState.context.setAgentImagery,
      setAgentImageryLoading: testState.context.setAgentImageryLoading,
    });
    renderPanel();

    expect(testState.context.setAgentImagery).toHaveBeenCalledWith(null);
    expect(testState.context.setAgentImageryLoading).toHaveBeenCalledWith(false);
  });
});
