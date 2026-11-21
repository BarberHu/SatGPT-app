import React, { useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../../context/AppContext';
import { buildAoiFromGridSelection } from '../../utils/aoi';
import { getOriginalFishnetRing, loadFishnetData } from '../../utils/fishnetSelection';
import { bindMapEvents, removeMapLayerAndSource } from '../../utils/mapLifecycle';

const AOI_SOURCE_ID = 'analysis-aoi';
const AOI_LAYER_IDS = ['analysis-aoi-fill', 'analysis-aoi-outline'];
function BasicMapController({ map, styleRevision = 0 }) {
  const mapRef = useRef(map);
  const utilityControlRef = useRef(null);
  const gridClickButtonRef = useRef(null);
  const lastFittedAoiRef = useRef(null);
  const gridClickEnabledRef = useRef(false);
  const {
    setMapInstance, setSelectedGridCords, setSelectedAOI, selectedAOI,
    gridClickEnabled, setGridClickEnabled, aoiOutlineVisible, setWarning,
    is3DEnabled, isBuildingsEnabled,
  } = useAppContext();

  useEffect(() => {
    gridClickEnabledRef.current = gridClickEnabled;
  }, [gridClickEnabled]);

  useEffect(() => {
    const button = gridClickButtonRef.current;
    if (!button) {
      return;
    }

    button.classList.toggle('active', gridClickEnabled);
    button.setAttribute('aria-pressed', String(gridClickEnabled));
    button.title = gridClickEnabled
      ? 'Click a grid cell to select a study area. Toggle off to hide the grid and selected boundary.'
      : 'Toggle on to show the grid and enable selection.';
  }, [gridClickEnabled]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    const visibility = gridClickEnabled ? 'visible' : 'none';
    for (const id of ['grid_cell-layer', ...AOI_LAYER_IDS]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }

    if (!gridClickEnabled) {
      map.getCanvas().style.cursor = '';
    }
  }, [gridClickEnabled]);

  const removeAoiLayers = useCallback((map) => {
    AOI_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    });

    if (map.getSource(AOI_SOURCE_ID)) {
      map.removeSource(AOI_SOURCE_ID);
    }
  }, []);

  const reconcileLayerOrder = useCallback((map) => {
    if (!map || map.active === false || !map.isStyleLoaded()) return;

    const orderedFromTopToBottom = [AOI_LAYER_IDS[1], AOI_LAYER_IDS[0], 'grid_cell-layer'];

    let beforeId;
    orderedFromTopToBottom.forEach((id) => {
      if (!map.getLayer(id)) return;
      try {
        if (beforeId && map.getLayer(beforeId)) {
          map.moveLayer(id, beforeId);
        } else {
          map.moveLayer(id);
        }
        beforeId = id;
      } catch (error) {
        console.warn(`Failed to reconcile layer order for ${id}:`, error);
      }
    });
  }, []);

  const loadGridLayer = useCallback((map) => {
    let disposed = false;
    let featuresByFid = null;
    if (!map.getSource('grid_cell')) map.addSource('grid_cell', {
      type: 'geojson',
      promoteId: 'FID',
      data: { type: 'FeatureCollection', features: [] },
    });

    loadFishnetData().then((data) => {
      if (disposed || !map.isStyleLoaded()) return;
      featuresByFid = data.featuresByFid;
      map.getSource('grid_cell')?.setData(data.geojson);
    }).catch((error) => {
      if (disposed) return;
      console.error('Failed to load original fishnet:', error);
      setWarning('Unable to load map grids. Please reload and try again.');
    });

    if (!map.getLayer('grid_cell-layer')) map.addLayer({
      id: 'grid_cell-layer',
      type: 'fill',
      source: 'grid_cell',
      layout: {
        visibility: gridClickEnabledRef.current ? 'visible' : 'none',
      },
      paint: {
        'fill-color': 'transparent',
        'fill-opacity': 1,
        'fill-outline-color': 'black',
      },
    });

    const handleGridClick = (e) => {
      if (!gridClickEnabledRef.current) return;
      if (!featuresByFid) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['grid_cell-layer'] });
      if (features.length > 0) {
        const cords = getOriginalFishnetRing(features[0], featuresByFid);
        const aoi = cords && buildAoiFromGridSelection(cords);
        if (!aoi) {
          setWarning('Unable to find the complete grid boundary. Please reload and try again.');
          return;
        }

        setSelectedGridCords(aoi.geojson.geometry.coordinates[0]);
        setSelectedAOI(aoi);
        setWarning('');
        reconcileLayerOrder(map);
      }
    };

    const handleGridMouseEnter = () => {
      if (!gridClickEnabledRef.current) return;
      map.getCanvas().style.cursor = 'pointer';
    };

    const handleGridMouseLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    const unbindEvents = bindMapEvents(map, [
      { event: 'click', layerId: 'grid_cell-layer', handler: handleGridClick },
      { event: 'mouseenter', layerId: 'grid_cell-layer', handler: handleGridMouseEnter },
      { event: 'mouseleave', layerId: 'grid_cell-layer', handler: handleGridMouseLeave },
    ]);
    return () => {
      disposed = true;
      unbindEvents();
      // The shared map outlives this controller, including StrictMode's effect
      // replay. Release the grid layer before its source so setup can run again.
      removeMapLayerAndSource(map, 'grid_cell-layer', 'grid_cell');
    };
  }, [reconcileLayerOrder, setSelectedAOI, setSelectedGridCords, setWarning]);

  const initializeLoadedMap = useCallback((map) => {
    setMapInstance(map);
    let utilityContainer = null;
    const utilityControl = {
      onAdd() {
        const container = document.createElement('div');
        utilityContainer = container;
        container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group satgpt-map-utility-group';

        const gridButton = document.createElement('button');
        gridButton.type = 'button';
        gridButton.className = 'satgpt-map-toggle-btn';
        gridButton.innerHTML = '<i class="fa fa-crosshairs" aria-hidden="true"></i>';
        gridButton.setAttribute('aria-label', 'Toggle grid selection');
        gridButton.setAttribute('title', 'Toggle grid selection');
        gridButton.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();

          setGridClickEnabled((previous) => !previous);
        };

        gridButton.classList.toggle('active', gridClickEnabledRef.current);
        gridButton.setAttribute('aria-pressed', String(gridClickEnabledRef.current));

        container.appendChild(gridButton);
        gridClickButtonRef.current = gridButton;
        return container;
      },
      onRemove() {
        const button = utilityContainer?.querySelector('button');
        if (button) button.onclick = null;
        if (gridClickButtonRef.current === button) gridClickButtonRef.current = null;
        utilityContainer?.remove();
        utilityContainer = null;
      },
    };

    map.addControl(utilityControl, 'top-right');
    utilityControlRef.current = utilityControl;
    return () => {
      if (utilityControlRef.current === utilityControl) {
        try {
          map.removeControl(utilityControl);
        } catch {
          // The map may already be tearing down its controls.
        }
        utilityControlRef.current = null;
      }
      setMapInstance(null);
    };
  }, [setGridClickEnabled, setMapInstance]);

  const handleMapStyleData = useCallback((map) => {
    window.requestAnimationFrame(() => reconcileLayerOrder(map));
  }, [reconcileLayerOrder]);

  // Attach Basic controls once to the scoped extension port. No engine ownership.
  const styleCallback = useRef(handleMapStyleData);
  styleCallback.current = handleMapStyleData;
  useEffect(() => {
    const cleanup = initializeLoadedMap(map);
    const onStyle = () => styleCallback.current(map);
    map.on('styledata', onStyle);
    return () => { map.off('styledata', onStyle); cleanup?.(); };
  }, [map]);

  useEffect(() => {
    const cleanup = loadGridLayer(map);
    reconcileLayerOrder(map);
    return cleanup;
  }, [map, styleRevision, loadGridLayer, reconcileLayerOrder]);

  const fitAoiBounds = useCallback((aoi, { force = false, padding = 50, duration = 600 } = {}) => {
    const map = mapRef.current;
    if (!map || !aoi?.bounds) return;

    const boundsKey = JSON.stringify(aoi.bounds || {});
    if (!force && boundsKey === lastFittedAoiRef.current) {
      return;
    }

    const { west, south, east, north } = aoi.bounds;
    map.fitBounds([[west, south], [east, north]], {
      padding,
      duration,
    });
    lastFittedAoiRef.current = boundsKey;
  }, []);

  // Handle 3D terrain
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (is3DEnabled) {
      if (!map.getSource('mapbox-dem')) map.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      });
      map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
    } else {
      if (map.getSource('mapbox-dem')) {
        map.setTerrain(null);
        map.removeSource('mapbox-dem');
      }
    }
  }, [is3DEnabled, styleRevision]);

  // Handle 3D buildings
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (isBuildingsEnabled) {
      const buildingSource = map.getSource('composite');
      if (buildingSource?.type === 'vector' && !map.getLayer('3d-buildings')) {
        map.addLayer({
          id: '3d-buildings',
          source: 'composite',
          'source-layer': 'building',
          filter: ['==', 'extrude', 'true'],
          type: 'fill-extrusion',
          minzoom: 15,
          paint: {
            'fill-extrusion-color': '#aaa',
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'min_height'],
            'fill-extrusion-opacity': 0.6,
          },
        });
      }
    } else {
      if (map.getLayer('3d-buildings')) {
        map.removeLayer('3d-buildings');
      }
    }
    reconcileLayerOrder(map);
  }, [isBuildingsEnabled, reconcileLayerOrder, styleRevision]);

  const displayedAoi = aoiOutlineVisible ? selectedAOI : null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = AOI_SOURCE_ID;
    const layerId = 'analysis-aoi-fill';
    const outlineLayerId = 'analysis-aoi-outline';

    removeAoiLayers(map);
    reconcileLayerOrder(map);

    if (!displayedAoi?.geojson) {
      lastFittedAoiRef.current = null;
      return;
    }

    if (!map.isStyleLoaded()) {
      return;
    }

    const layout = { visibility: gridClickEnabledRef.current ? 'visible' : 'none' };
    map.addSource(sourceId, {
      type: 'geojson',
      data: displayedAoi.geojson,
    });

    map.addLayer({
      id: layerId,
      type: 'fill',
      source: sourceId,
      layout,
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': 0.1,
      },
    });

    map.addLayer({
      id: outlineLayerId,
      type: 'line',
      source: sourceId,
      layout,
      paint: {
        'line-color': '#3b82f6',
        'line-width': 2,
      },
    });

    reconcileLayerOrder(map);

    const boundsKey = JSON.stringify(displayedAoi.bounds || {});
    if (displayedAoi.bounds && boundsKey !== lastFittedAoiRef.current) {
      fitAoiBounds(displayedAoi, { padding: 50, duration: 0 });
    }
  }, [displayedAoi, fitAoiBounds, reconcileLayerOrder, removeAoiLayers, styleRevision]);

  return null;
}

export default BasicMapController;
