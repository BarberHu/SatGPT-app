import React, { useEffect, useRef, useCallback, useState } from 'react';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { useAppContext } from '../../context/AppContext';
import { buildAoiFromDrawFeatures, buildAoiFromGridSelection, getDrawFeaturesFromAoi } from '../../utils/aoi';
import { getOriginalFishnetRing, loadFishnetData } from '../../utils/fishnetSelection';
import { bindMapEvents, removeMapLayerAndSource } from '../../utils/mapLifecycle';

const AOI_SOURCE_ID = 'analysis-aoi';
const AOI_LAYER_IDS = ['analysis-aoi-fill', 'analysis-aoi-outline'];
const DRAW_BLUE = '#2563eb';
const DRAW_ORANGE = '#f97316';
const DRAW_WHITE = '#ffffff';
const DRAW_STYLES = [
  {
    id: 'gl-draw-polygon-fill',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon']],
    paint: {
      'fill-color': [
        'case',
        ['==', ['get', 'active'], 'true'], DRAW_ORANGE,
        DRAW_BLUE,
      ],
      'fill-opacity': 0.14,
    },
  },
  {
    id: 'gl-draw-lines',
    type: 'line',
    filter: [
      'any',
      ['==', '$type', 'LineString'],
      ['==', '$type', 'Polygon'],
    ],
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': [
        'case',
        ['==', ['get', 'active'], 'true'], DRAW_ORANGE,
        DRAW_BLUE,
      ],
      'line-dasharray': [
        'case',
        ['==', ['get', 'active'], 'true'], ['literal', [0.2, 2]],
        ['literal', [2, 0]],
      ],
      'line-width': 2.5,
    },
  },
  {
    id: 'gl-draw-point-outer',
    type: 'circle',
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'feature'],
    ],
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'active'], 'true'], 7,
        5,
      ],
      'circle-color': DRAW_WHITE,
    },
  },
  {
    id: 'gl-draw-point-inner',
    type: 'circle',
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'feature'],
    ],
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'active'], 'true'], 5,
        3,
      ],
      'circle-color': [
        'case',
        ['==', ['get', 'active'], 'true'], DRAW_ORANGE,
        DRAW_BLUE,
      ],
    },
  },
  {
    id: 'gl-draw-vertex-outer',
    type: 'circle',
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'vertex'],
      ['!=', 'mode', 'simple_select'],
    ],
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'active'], 'true'], 7,
        5,
      ],
      'circle-color': DRAW_WHITE,
    },
  },
  {
    id: 'gl-draw-vertex-inner',
    type: 'circle',
    filter: [
      'all',
      ['==', '$type', 'Point'],
      ['==', 'meta', 'vertex'],
      ['!=', 'mode', 'simple_select'],
    ],
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'active'], 'true'], 5,
        3,
      ],
      'circle-color': DRAW_ORANGE,
    },
  },
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint']],
    paint: {
      'circle-radius': 3,
      'circle-color': DRAW_ORANGE,
    },
  },
];

function BasicMapController({ map }) {
  const mapRef = useRef(map);
  const drawRef = useRef(null);
  const utilityControlRef = useRef(null);
  const gridClickButtonRef = useRef(null);
  const lastFittedAoiRef = useRef(null);
  const gridClickEnabledRef = useRef(false);
  const programmaticDrawMutationRef = useRef(false);
  const isAoiEditingRef = useRef(false);
  const editableGeojsonRef = useRef(null);
  const [isPolygonDrawMode, setIsPolygonDrawMode] = useState(false);
  const {
    setMapInstance, setSelectedGridCords, setSelectedAOI, setDraftAOI,
    selectedAOI, draftAOI, aoiClearVersion, gridClickEnabled, setGridClickEnabled,
    isAoiEditing, aoiEditorMode, setAoiEditorMode, aoiOutlineVisible, setWarning, resetAskSession, is3DEnabled, isBuildingsEnabled,
  } = useAppContext();

  useEffect(() => {
    gridClickEnabledRef.current = gridClickEnabled;
  }, [gridClickEnabled]);

  useEffect(() => {
    const button = gridClickButtonRef.current;
    if (!button) {
      return;
    }

    const disabled = isAoiEditing || isPolygonDrawMode;
    button.disabled = disabled;
    button.classList.toggle('active', gridClickEnabled && !disabled);
    button.classList.toggle('disabled', disabled);
    button.setAttribute('aria-pressed', gridClickEnabled && !disabled ? 'true' : 'false');
    button.title = disabled
      ? 'Drawing is in progress, so grid selection is temporarily disabled.'
      : (gridClickEnabled ? 'Click map grids to select a study area.' : 'Map grid selection is off.');
  }, [gridClickEnabled, isAoiEditing, isPolygonDrawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getLayer('grid_cell-layer')) {
      return;
    }

    map.setLayoutProperty(
      'grid_cell-layer',
      'visibility',
      gridClickEnabled ? 'visible' : 'none'
    );

    if (!gridClickEnabled) {
      map.getCanvas().style.cursor = '';
    }
  }, [gridClickEnabled]);

  useEffect(() => {
    isAoiEditingRef.current = isAoiEditing;
  }, [isAoiEditing]);

  useEffect(() => {
    editableGeojsonRef.current = draftAOI?.geojson || selectedAOI?.geojson || null;
  }, [draftAOI, selectedAOI]);

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

  const getExistingLayerBands = useCallback((map) => {
    const ids = (map.getStyle()?.layers || []).map(layer => layer.id);
    return {
      gridLayers: ids.filter(id => id === 'grid_cell-layer'),
      aoiLayers: AOI_LAYER_IDS.filter(id => ids.includes(id)),
      drawLayers: ids.filter(id => id.startsWith('gl-draw-')),
    };
  }, []);

  const promoteDrawLayers = useCallback((map) => {
    if (!map || map.active === false || !map.isStyleLoaded()) return;

    const { drawLayers } = getExistingLayerBands(map);
    const top = (map.getStyle()?.layers || []).slice(-drawLayers.length).map(layer => layer.id);
    if (drawLayers.every((id, index) => top[index] === id)) return;
    drawLayers.forEach((id) => {
      if (!map.getLayer(id)) return;
      try {
        map.moveLayer(id);
      } catch (error) {
        console.warn(`Failed to promote draw layer ${id}:`, error);
      }
    });
  }, [getExistingLayerBands]);

  const schedulePromoteDrawLayers = useCallback((map, passCount = 3) => {
    if (!map) return;

    let remainingPasses = passCount;
    const run = () => {
      if (mapRef.current !== map || !map.isStyleLoaded()) {
        return;
      }

      promoteDrawLayers(map);
      remainingPasses -= 1;
      if (remainingPasses > 0) {
        window.requestAnimationFrame(run);
      }
    };

    window.requestAnimationFrame(run);
  }, [promoteDrawLayers]);

  const reconcileLayerOrder = useCallback((map) => {
    if (!map || map.active === false || !map.isStyleLoaded()) return;

    const {
      gridLayers,
      aoiLayers,
      drawLayers,
    } = getExistingLayerBands(map);

    const orderedFromTopToBottom = [
      ...drawLayers.slice().reverse(),
      ...aoiLayers.slice().reverse(),
      ...gridLayers.slice().reverse(),
    ];

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
  }, [getExistingLayerBands]);

  const loadGridLayer = useCallback((map) => {
    let disposed = false;
    let featuresByFid = null;
    if (!map.getSource('grid_cell')) map.addSource('grid_cell', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    loadFishnetData().then((data) => {
      if (disposed) return;
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
      if (!gridClickEnabledRef.current || isAoiEditingRef.current) return;
      if (!featuresByFid) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['grid_cell-layer'] });
      if (features.length > 0) {
        const cords = getOriginalFishnetRing(features[0], featuresByFid);
        const aoi = cords && buildAoiFromGridSelection(cords);
        if (!aoi) {
          setWarning('Unable to find the complete grid boundary. Please reload and try again.');
          return;
        }

        // Keep the answer while selecting the study area for a preset.
        resetAskSession({ preserveResult: true });
        setSelectedGridCords(aoi.geojson.geometry.coordinates[0]);
        setDraftAOI(null);
        setSelectedAOI(aoi);
        setWarning('');
        reconcileLayerOrder(map);
      }
    };

    const handleGridMouseEnter = () => {
      if (!gridClickEnabledRef.current || isAoiEditingRef.current) return;
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
  }, [reconcileLayerOrder, resetAskSession, setDraftAOI, setSelectedAOI, setSelectedGridCords, setWarning]);

  const initializeLoadedMap = useCallback((map) => {
    setMapInstance(map);
    drawRef.current = new MapboxDraw({
        displayControlsDefault: false,
        defaultMode: 'simple_select',
        controls: {
          polygon: true,
          trash: true,
        },
        styles: DRAW_STYLES,
      });
    map.addControl(drawRef.current, 'top-right');

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

          if (
            isAoiEditingRef.current
            || drawRef.current?.getMode?.() === 'draw_polygon'
          ) {
            return;
          }

          setGridClickEnabled((previous) => !previous);
        };

        const disabled = isAoiEditingRef.current
          || drawRef.current?.getMode?.() === 'draw_polygon';
        gridButton.disabled = disabled;
        gridButton.classList.toggle('active', gridClickEnabledRef.current && !disabled);
        gridButton.classList.toggle('disabled', disabled);
        gridButton.setAttribute('aria-pressed', gridClickEnabledRef.current && !disabled ? 'true' : 'false');

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
    const cleanupGridEvents = loadGridLayer(map);
    window.requestAnimationFrame(() => reconcileLayerOrder(map));

    return () => {
      cleanupGridEvents?.();
      if (utilityControlRef.current === utilityControl) {
        try {
          map.removeControl(utilityControl);
        } catch {
          // The map may already be tearing down its controls.
        }
        utilityControlRef.current = null;
      }
      if (drawRef.current) {
        try {
          map.removeControl(drawRef.current);
        } catch {
          // The map may already be tearing down its controls.
        }
        drawRef.current = null;
      }
      setMapInstance(null);
    };
  }, [loadGridLayer, reconcileLayerOrder, setGridClickEnabled, setMapInstance]);

  const handleMapStyleData = useCallback((map) => {
    window.requestAnimationFrame(() => {
      reconcileLayerOrder(map);
      promoteDrawLayers(map);
    });
  }, [promoteDrawLayers, reconcileLayerOrder]);

  // Attach Basic controls once to the scoped extension port. No engine ownership.
  const styleCallback = useRef(handleMapStyleData);
  styleCallback.current = handleMapStyleData;
  useEffect(() => {
    const cleanup = initializeLoadedMap(map);
    const onStyle = () => styleCallback.current(map);
    map.on('styledata', onStyle);
    return () => { map.off('styledata', onStyle); cleanup?.(); };
  }, [map]);

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

  const runProgrammaticDrawMutation = useCallback((callback) => {
    programmaticDrawMutationRef.current = true;
    try {
      callback();
    } finally {
      window.setTimeout(() => {
        programmaticDrawMutationRef.current = false;
      }, 0);
    }
  }, []);

  const syncDraftFromFeatures = useCallback((features) => {
    const nextDraftAoi = buildAoiFromDrawFeatures(features, {
      id: draftAOI?.id,
      source: aoiEditorMode === 'edit' ? 'edited' : 'draw',
      label: draftAOI?.label || selectedAOI?.label || 'Manual scope',
    });

    if (!nextDraftAoi) {
      setDraftAOI(null);
      setWarning('Current drawing result is not a valid spatial scope. Please redraw the polygon.');
      return;
    }

    setDraftAOI({ ...nextDraftAoi, aoi_ref: null, edit_ref: draftAOI?.edit_ref || null });
    setWarning('');
  }, [aoiEditorMode, draftAOI, selectedAOI, setDraftAOI, setWarning]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw) return;

    const syncDrawModeState = (event) => {
      const nextMode = event?.mode || draw.getMode?.() || 'simple_select';
      const drawingPolygon = nextMode === 'draw_polygon';
      setIsPolygonDrawMode(drawingPolygon);
      if (drawingPolygon && !isAoiEditingRef.current) setAoiEditorMode('draw');
      if (drawingPolygon && gridClickEnabledRef.current) {
        setGridClickEnabled(false);
      }
      if (drawingPolygon) {
        schedulePromoteDrawLayers(map);
      }
    };

    const handleCreate = (event) => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      const createdFeature = event.features?.find((feature) => feature.geometry?.type === 'Polygon');
      if (!createdFeature) {
        setDraftAOI(null);
        setWarning('Please draw a valid polygon spatial scope.');
        return;
      }

      syncDraftFromFeatures(draw.getAll().features || []);

      if (createdFeature.id) {
        window.requestAnimationFrame(() => {
          if (!drawRef.current || !isAoiEditingRef.current) {
            return;
          }

          try {
            drawRef.current.changeMode('direct_select', { featureId: createdFeature.id });
          } catch (error) {
            try {
              drawRef.current.changeMode('simple_select', { featureIds: [createdFeature.id] });
            } catch (fallbackError) {
              console.warn('Failed to switch draw mode after polygon creation:', fallbackError);
            }
          }
          promoteDrawLayers(map);
        });
      }
    };

    const handleUpdate = () => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      syncDraftFromFeatures(draw.getAll().features || []);
      promoteDrawLayers(map);
    };

    const handleDelete = () => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      const remainingFeatures = draw.getAll().features || [];
      if (!remainingFeatures.length) {
        setDraftAOI(null);
        setWarning('');
      } else {
        syncDraftFromFeatures(remainingFeatures);
      }
      promoteDrawLayers(map);
    };

    const handleDrawRender = () => {
      promoteDrawLayers(map);
    };

    map.on('draw.create', handleCreate);
    map.on('draw.update', handleUpdate);
    map.on('draw.delete', handleDelete);
    map.on('draw.modechange', syncDrawModeState);
    map.on('draw.render', handleDrawRender);
    syncDrawModeState({ mode: draw.getMode?.() || 'simple_select' });

    return () => {
      map.off('draw.create', handleCreate);
      map.off('draw.update', handleUpdate);
      map.off('draw.delete', handleDelete);
      map.off('draw.modechange', syncDrawModeState);
      map.off('draw.render', handleDrawRender);
    };
  }, [
    gridClickEnabled,
    promoteDrawLayers,
    setGridClickEnabled,
    setDraftAOI,
    setWarning,
    schedulePromoteDrawLayers,
    syncDraftFromFeatures,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!draw) return;

    if (aoiEditorMode === 'idle') {
      runProgrammaticDrawMutation(() => {
        draw.deleteAll();
        draw.changeMode('simple_select');
      });
      if (map) {
        window.requestAnimationFrame(() => reconcileLayerOrder(map));
      }
      return;
    }

    if (aoiEditorMode === 'draw') {
      runProgrammaticDrawMutation(() => {
        draw.deleteAll();
      });
      setDraftAOI(null);
      setWarning('');
      draw.changeMode('draw_polygon');
      if (map) {
        schedulePromoteDrawLayers(map);
      }
      return;
    }

    if (aoiEditorMode === 'edit') {
      const editableFeature = editableGeojsonRef.current;
      const editableFeatures = getDrawFeaturesFromAoi({ geojson: editableFeature });
      if (!editableFeatures.length) {
        const editWarning = 'Current spatial scope cannot be edited. Please select, upload, or draw a valid scope first.';
        setWarning(editWarning);
        return;
      }

      let featureIds = [];
      runProgrammaticDrawMutation(() => {
        draw.deleteAll();
        featureIds = draw.add({
          type: 'FeatureCollection',
          features: editableFeatures,
        });
      });
      const featureId = Array.isArray(featureIds) ? featureIds[0] : featureIds;

      if (featureId) {
        try {
          draw.changeMode('direct_select', { featureId });
        } catch (error) {
          draw.changeMode('simple_select', { featureIds: [featureId] });
        }
      }

      if (map) {
        schedulePromoteDrawLayers(map);
      }
    }
  }, [aoiEditorMode, reconcileLayerOrder, runProgrammaticDrawMutation, schedulePromoteDrawLayers, setDraftAOI, setWarning]);
  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map) return;

    removeAoiLayers(map);
    lastFittedAoiRef.current = null;
    map.getCanvas().style.cursor = '';

    if (draw) {
      try {
        draw.deleteAll();
        draw.changeMode('simple_select');
      } catch (error) {
        console.warn('Failed to reset draw state during AOI clear:', error);
      }
    }

    reconcileLayerOrder(map);
  }, [aoiClearVersion, reconcileLayerOrder, removeAoiLayers]);

  // Handle 3D terrain
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (is3DEnabled) {
      map.addSource('mapbox-dem', {
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
  }, [is3DEnabled]);

  // Handle 3D buildings
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (isBuildingsEnabled) {
      if (!map.getLayer('3d-buildings')) {
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
  }, [isBuildingsEnabled, reconcileLayerOrder]);

  const displayedAoi = isAoiEditing || aoiOutlineVisible === false ? null : selectedAOI;

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

    map.addSource(sourceId, {
      type: 'geojson',
      data: displayedAoi.geojson,
    });

    map.addLayer({
      id: layerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': 0.1,
      },
    });

    map.addLayer({
      id: outlineLayerId,
      type: 'line',
      source: sourceId,
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
  }, [displayedAoi, fitAoiBounds, reconcileLayerOrder, removeAoiLayers]);

  return null;
}

export default BasicMapController;
