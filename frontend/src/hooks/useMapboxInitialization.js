import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

export default function useMapboxInitialization({
  containerRef,
  mapRef,
  initializedRef,
  styleUrl,
  center,
  zoom,
  onLoad,
  onStyleData,
}) {
  const callbacksRef = useRef({ onLoad, onStyleData });

  useEffect(() => {
    callbacksRef.current = { onLoad, onStyleData };
  }, [onLoad, onStyleData]);

  useEffect(() => {
    if (initializedRef.current || mapRef.current || !containerRef.current) {
      return undefined;
    }

    initializedRef.current = true;
    containerRef.current.innerHTML = '';

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: styleUrl,
      center,
      zoom,
    });
    const navigationControl = new mapboxgl.NavigationControl();
    map.addControl(navigationControl, 'top-right');

    let cleanupLoadedMap = null;
    const handleLoad = () => {
      mapRef.current = map;
      cleanupLoadedMap = callbacksRef.current.onLoad?.(map) || null;
    };
    const handleStyleData = () => {
      callbacksRef.current.onStyleData?.(map);
    };

    map.on('load', handleLoad);
    map.on('styledata', handleStyleData);

    return () => {
      map.off('load', handleLoad);
      map.off('styledata', handleStyleData);
      cleanupLoadedMap?.();
      try {
        map.removeControl(navigationControl);
      } catch (error) {
        // The style may already have removed controls during teardown.
      }
      map.remove();
      if (mapRef.current === map) {
        mapRef.current = null;
      }
      initializedRef.current = false;
    };
  }, [center, containerRef, initializedRef, mapRef, styleUrl, zoom]);
}
