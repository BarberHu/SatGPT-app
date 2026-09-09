import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import useMapboxInitialization from './useMapboxInitialization';

jest.mock('mapbox-gl', () => ({
  Map: jest.fn(),
  NavigationControl: jest.fn(() => ({ type: 'navigation' })),
}));

const createMap = () => ({
  addControl: jest.fn(),
  off: jest.fn(),
  on: jest.fn(),
  remove: jest.fn(),
  removeControl: jest.fn(),
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
    jest.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('pairs load and style listeners and disposes the map', () => {
    const cleanupLoadedMap = jest.fn();
    const onLoad = jest.fn(() => cleanupLoadedMap);
    const onStyleData = jest.fn();

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
