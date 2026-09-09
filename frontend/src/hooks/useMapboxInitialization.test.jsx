import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import useMapboxInitialization from './useMapboxInitialization';

vi.mock('mapbox-gl', () => {
  const mapboxgl = {
    Map: vi.fn(),
    NavigationControl: vi.fn(() => ({ type: 'navigation' })),
  };
  return { default: mapboxgl, ...mapboxgl };
});

const createMap = () => ({
  addControl: vi.fn(),
  off: vi.fn(),
  on: vi.fn(),
  remove: vi.fn(),
  removeControl: vi.fn(),
});

function HookHarness({ onLoad, onStyleData }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const initializedRef = useRef(false);

  useMapboxInitialization({
    containerRef,
    mapRef,
    initializedRef,
    styleUrl: 'mapbox://styles/test',
    center: [0, 0],
    zoom: 4,
    onLoad,
    onStyleData,
  });

  return <div ref={containerRef} />;
}

describe('useMapboxInitialization', () => {
  let container;
  let root;
  let map;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    map = createMap();
    mapboxgl.Map.mockReturnValue(map);
  });

  afterEach(() => {
    if (container) {
      act(() => root.unmount());
    }
    vi.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('pairs load and style listeners and disposes the map', () => {
    const cleanupLoadedMap = vi.fn();
    const onLoad = vi.fn(() => cleanupLoadedMap);
    const onStyleData = vi.fn();

    act(() => {
      root.render(<HookHarness onLoad={onLoad} onStyleData={onStyleData} />);
    });

    const loadHandler = map.on.mock.calls.find(([event]) => event === 'load')[1];
    const styleHandler = map.on.mock.calls.find(([event]) => event === 'styledata')[1];
    act(() => {
      loadHandler();
      styleHandler();
    });
    expect(onLoad).toHaveBeenCalledWith(map);
    expect(onStyleData).toHaveBeenCalledWith(map);

    act(() => root.unmount());
    container = null;

    expect(map.off).toHaveBeenCalledWith('load', loadHandler);
    expect(map.off).toHaveBeenCalledWith('styledata', styleHandler);
    expect(cleanupLoadedMap).toHaveBeenCalledTimes(1);
    expect(map.remove).toHaveBeenCalledTimes(1);
  });
});
