import React, { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { useAppContext } from '../context/AppContext';
import { buildAoiFromAgentState, buildAoiFromDrawFeature, buildAoiFromGridSelection } from '../utils/aoi';

// Mapbox access token - should be set via environment variable
mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_KEY || '';

const DEFAULT_CENTER = [102.0, 16.5];
const DEFAULT_ZOOM = 5;

// Custom Mapbox style (same as original project)
const MAPBOX_STYLE = 'mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp';
const ASK_LAYER_NAMES = ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
const AGENT_SOURCE_IDS = [
  'agent-s2-pre', 'agent-s2-peek', 'agent-s2-after',
  'agent-s1-pre', 'agent-s1-peek', 'agent-s1-after',
  'agent-flood-detection', 'agent-population', 'agent-urban', 'agent-landcover',
];
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

function MapContainer() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const lastFittedAoiRef = useRef(null);
  const gridClickEnabledRef = useRef(true);
  const isAoiEditingRef = useRef(false);
  const editableGeojsonRef = useRef(null);
  
  const {
    setMapInstance,
    setSelectedGridCords,
    setSelectedAOI,
    setDraftAOI,
    selectedAOI,
    draftAOI,
    gridClickEnabled,
    isAoiEditing,
    aoiEditorMode,
    setWarning,
    resetAgentSession,
    resetAskSession,
    layerData,
    layerVisibility,
    layerOpacity,
    is3DEnabled,
    isBuildingsEnabled,
    appMode,
    agentImagery,
    floodAgentState,
    // Agent control states
    agentSelectedPeriod,
    agentSelectedType,
    agentShowFloodDetection,
    agentShowPopulationLayer,
    agentShowUrbanLayer,
    agentShowLandcoverLayer,
    agentImpactData,
    setAgentLayerLoading,
    setAgentTileError,
  } = useAppContext();

  // Track if map is initialized
  const mapInitialized = useRef(false);

  useEffect(() => {
    gridClickEnabledRef.current = gridClickEnabled;
  }, [gridClickEnabled]);

  useEffect(() => {
    isAoiEditingRef.current = isAoiEditing;
  }, [isAoiEditing]);

  useEffect(() => {
    editableGeojsonRef.current = draftAOI?.geojson || selectedAOI?.geojson || null;
  }, [draftAOI, selectedAOI]);

  const removeAskLayers = useCallback((map) => {
    ASK_LAYER_NAMES.forEach((id) => {
      if (map.getLayer(`${id}-layer`)) {
        map.removeLayer(`${id}-layer`);
      }
    });

    ASK_LAYER_NAMES.forEach((id) => {
      if (map.getSource(id)) {
        map.removeSource(id);
      }
    });
  }, []);

  const removeAgentLayers = useCallback((map) => {
    AGENT_SOURCE_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    });

    AGENT_SOURCE_IDS.forEach((id) => {
      if (map.getSource(id)) {
        map.removeSource(id);
      }
    });
  }, []);

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

  const loadGridLayer = useCallback((map) => {
    map.addSource('grid_cell', {
      type: 'geojson',
      data: '/static/HFMT_Fishnet_3_FeaturesToJSO.geojson',
    });

    map.addLayer({
      id: 'grid_cell-layer',
      type: 'fill',
      source: 'grid_cell',
      paint: {
        'fill-color': 'transparent',
        'fill-opacity': 1,
        'fill-outline-color': 'black',
      },
    });

    // Grid cell click handler
    map.on('click', 'grid_cell-layer', (e) => {
      if (!gridClickEnabledRef.current || isAoiEditingRef.current) return;
      const features = map.queryRenderedFeatures(e.point, { layers: ['grid_cell-layer'] });
      if (features.length > 0 && features[0].geometry) {
        const cords = features[0].geometry.coordinates[0];
        
        // Remove previous EE layers before setting new grid
        removeAskLayers(map);
        removeAgentLayers(map);
        
        // Set new grid coordinates (this triggers useMapData to fetch new data)
        resetAskSession();
        setSelectedGridCords(cords);
        setDraftAOI(null);
        setSelectedAOI(buildAoiFromGridSelection(cords));
        resetAgentSession({ preserveSelectedAoi: true });
      }
    });

    // Change cursor on hover
    map.on('mouseenter', 'grid_cell-layer', () => {
      if (!gridClickEnabledRef.current || isAoiEditingRef.current) return;
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', 'grid_cell-layer', () => {
      map.getCanvas().style.cursor = '';
    });
  }, [removeAgentLayers, removeAskLayers, resetAgentSession, resetAskSession, setDraftAOI, setSelectedAOI, setSelectedGridCords]);

  // Initialize map
  useEffect(() => {
    if (mapInitialized.current || mapRef.current) return;
    mapInitialized.current = true;

    if (mapContainerRef.current) {
      mapContainerRef.current.innerHTML = '';
    }

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAPBOX_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapRef.current = map;
      setMapInstance(map);
      drawRef.current = new MapboxDraw({
        displayControlsDefault: false,
        defaultMode: 'simple_select',
        styles: DRAW_STYLES,
      });
      map.addControl(drawRef.current, 'top-right');
      loadGridLayer(map);
    });

    return () => {
      if (mapRef.current) {
        drawRef.current = null;
        mapRef.current.remove();
        mapRef.current = null;
        mapInitialized.current = false;
      }
    };
  }, [loadGridLayer, resetAgentSession, setMapInstance]);

  const syncDraftFromFeature = useCallback((feature) => {
    const nextDraftAoi = buildAoiFromDrawFeature(feature, {
      source: aoiEditorMode === 'edit' ? 'edited' : 'draw',
      label: selectedAOI?.label || 'Manual boundary',
    });

    if (!nextDraftAoi) {
      setDraftAOI(null);
      setWarning('当前绘制结果不是有效的单 Polygon，请重新绘制。');
      return;
    }

    setDraftAOI(nextDraftAoi);
    setWarning('');
  }, [aoiEditorMode, selectedAOI, setDraftAOI, setWarning]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw) return;

    const handleCreate = (event) => {
      const createdFeature = event.features?.find((feature) => feature.geometry?.type === 'Polygon');
      if (!createdFeature) {
        setDraftAOI(null);
        setWarning('请绘制一个有效的 Polygon 边界。');
        return;
      }

      const allFeatures = draw.getAll().features || [];
      allFeatures
        .filter((feature) => feature.id !== createdFeature.id)
        .forEach((feature) => draw.delete(feature.id));

      syncDraftFromFeature(createdFeature);

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
        });
      }
    };

    const handleUpdate = (event) => {
      const updatedFeature = event.features?.find((feature) => feature.geometry?.type === 'Polygon')
        || draw.getAll().features.find((feature) => feature.geometry?.type === 'Polygon');
      syncDraftFromFeature(updatedFeature);
    };

    const handleDelete = () => {
      setDraftAOI(null);
    };

    map.on('draw.create', handleCreate);
    map.on('draw.update', handleUpdate);
    map.on('draw.delete', handleDelete);

    return () => {
      map.off('draw.create', handleCreate);
      map.off('draw.update', handleUpdate);
      map.off('draw.delete', handleDelete);
    };
  }, [setDraftAOI, setWarning, syncDraftFromFeature]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;

    if (aoiEditorMode === 'idle') {
      draw.deleteAll();
      draw.changeMode('simple_select');
      return;
    }

    if (aoiEditorMode === 'draw') {
      draw.deleteAll();
      setDraftAOI(null);
      setWarning('');
      draw.changeMode('draw_polygon');
      return;
    }

    if (aoiEditorMode === 'edit') {
      const editableFeature = editableGeojsonRef.current;
      if (!editableFeature?.geometry || editableFeature.geometry.type !== 'Polygon') {
        setWarning('当前边界无法进入编辑模式，请先选择或绘制一个单 Polygon。');
        return;
      }

      draw.deleteAll();
      const featureIds = draw.add(editableFeature);
      const featureId = Array.isArray(featureIds) ? featureIds[0] : featureIds;

      if (featureId) {
        try {
          draw.changeMode('direct_select', { featureId });
        } catch (error) {
          draw.changeMode('simple_select', { featureIds: [featureId] });
        }
      }
    }
  }, [aoiEditorMode, setDraftAOI, setWarning]);

  // Update EE layers when layer data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    ASK_LAYER_NAMES.forEach((layerName) => {
      const data = layerData[layerName];
      
      // Remove existing layer and source
      if (map.getLayer(`${layerName}-layer`)) {
        map.removeLayer(`${layerName}-layer`);
      }
      if (map.getSource(layerName)) {
        map.removeSource(layerName);
      }

      // Add new layer if data exists
      if (data && data.tileUrl) {
        map.addSource(layerName, {
          type: 'raster',
          tiles: [data.tileUrl],
          tileSize: 256,
        });

        map.addLayer({
          id: `${layerName}-layer`,
          type: 'raster',
          source: layerName,
          paint: {
            'raster-opacity': layerVisibility[layerName] ? layerOpacity[layerName] : 0,
          },
        });
      }
    });
  }, [layerData, layerOpacity, layerVisibility]);

  // Update layer visibility and opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    ASK_LAYER_NAMES.forEach((layerName) => {
      if (map.getLayer(`${layerName}-layer`)) {
        const opacity = layerVisibility[layerName] ? layerOpacity[layerName] : 0;
        map.setPaintProperty(`${layerName}-layer`, 'raster-opacity', opacity);
      }
    });
  }, [layerVisibility, layerOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (appMode === 'ask') {
      removeAgentLayers(map);
    } else {
      removeAskLayers(map);
    }
  }, [appMode, removeAgentLayers, removeAskLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (appMode === 'ask') {
      removeAskLayers(map);
    } else {
      removeAgentLayers(map);
      setAgentTileError(null);
    }
  }, [appMode, selectedAOI, removeAgentLayers, removeAskLayers, setAgentTileError]);

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
  }, [isBuildingsEnabled]);

  // ========== Helper: per-layer tile loading lifecycle ==========
  // Creates standard idle/timeout handlers for a single layer, managing its own loading key.
  const createLayerTileLifecycle = useCallback((map, layerKey) => {
    setAgentLayerLoading(prev => ({ ...prev, [layerKey]: true }));

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      setAgentLayerLoading(prev => ({ ...prev, [layerKey]: false }));
    };
    map.once('idle', finish);
    const timeout = setTimeout(finish, 15000);

    return {
      cleanup: () => {
        resolved = true;
        setAgentLayerLoading(prev => ({ ...prev, [layerKey]: false }));
        map.off('idle', finish);
        clearTimeout(timeout);
      },
    };
  }, [setAgentLayerLoading]);

  // ========== Effect A: Base Sentinel Imagery ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    const sentinelIds = [
      'agent-s2-pre', 'agent-s2-peek', 'agent-s2-after',
      'agent-s1-pre', 'agent-s1-peek', 'agent-s1-after',
    ];
    sentinelIds.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });

    if (!agentImagery) return;

    setAgentTileError(null);

    const periodKey = agentSelectedPeriod;
    const typeKey = agentSelectedType;
    const periodData = agentImagery[periodKey];

    if (!periodData?.[typeKey]?.tile_url) return;

    const sourceId = `agent-${typeKey === 'sentinel2' ? 's2' : 's1'}-${periodKey.replace('_date', '')}`;
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [periodData[typeKey].tile_url],
      tileSize: 256,
    });
    map.addLayer({
      id: sourceId,
      type: 'raster',
      source: sourceId,
      paint: { 'raster-opacity': 1 },
    });

    // Track tile errors (only on base imagery since it's the primary GEE layer)
    let tileErrorCount = 0;
    const onTileError = (e) => {
      if (e?.error?.status >= 400 || e?.error?.message?.includes('HTTP') || e?.type === 'error') {
        tileErrorCount++;
        console.warn('⚠️ Tile load error:', e?.sourceId || 'unknown', e?.error?.message || '');
      }
    };
    map.on('error', onTileError);

    setAgentLayerLoading(prev => ({ ...prev, 'base-imagery': true }));

    let resolved = false;
    const finish = (isTimeout) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      setAgentLayerLoading(prev => ({ ...prev, 'base-imagery': false }));
      if (tileErrorCount > 0) {
        console.warn(`⚠️ ${tileErrorCount} tile(s) failed to load.`);
        setAgentTileError({
          count: tileErrorCount,
          message: isTimeout
            ? 'Map tiles timed out. The GEE imagery URL may have expired — try re-running the analysis.'
            : 'Some map tiles failed to load. The imagery URL may have expired — try re-running the analysis.',
          timestamp: Date.now(),
        });
      } else {
        setAgentTileError(null);
      }
    };
    map.once('idle', () => finish(false));
    const timeout = setTimeout(() => finish(true), 15000);

    return () => {
      resolved = true;
      setAgentLayerLoading(prev => ({ ...prev, 'base-imagery': false }));
      map.off('error', onTileError);
      map.off('idle', finish);
      clearTimeout(timeout);
    };
  }, [agentImagery, appMode, agentSelectedPeriod, agentSelectedType, setAgentLayerLoading, setAgentTileError]);

  // ========== Effect B: Flood Detection Overlay ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    if (map.getLayer('agent-flood-detection')) map.removeLayer('agent-flood-detection');
    if (map.getSource('agent-flood-detection')) map.removeSource('agent-flood-detection');

    if (!agentShowFloodDetection || !agentImagery?.flood_detection?.tile_url) return;

    map.addSource('agent-flood-detection', {
      type: 'raster',
      tiles: [agentImagery.flood_detection.tile_url],
      tileSize: 256,
    });
    map.addLayer({
      id: 'agent-flood-detection',
      type: 'raster',
      source: 'agent-flood-detection',
      paint: { 'raster-opacity': 0.7 },
    });

    const lifecycle = createLayerTileLifecycle(map, 'flood-detection');
    return lifecycle.cleanup;
  }, [agentImagery, appMode, agentShowFloodDetection, createLayerTileLifecycle]);

  // ========== Effect C: Population Impact Overlay ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    if (map.getLayer('agent-population')) map.removeLayer('agent-population');
    if (map.getSource('agent-population')) map.removeSource('agent-population');

    if (!agentShowPopulationLayer || !agentImpactData?.layers?.population?.tile_url) return;

    map.addSource('agent-population', {
      type: 'raster',
      tiles: [agentImpactData.layers.population.tile_url],
      tileSize: 256,
    });
    map.addLayer({
      id: 'agent-population',
      type: 'raster',
      source: 'agent-population',
      paint: { 'raster-opacity': 0.7 },
    });

    const lifecycle = createLayerTileLifecycle(map, 'population');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowPopulationLayer, createLayerTileLifecycle]);

  // ========== Effect D: Built-up Area Overlay ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    if (map.getLayer('agent-urban')) map.removeLayer('agent-urban');
    if (map.getSource('agent-urban')) map.removeSource('agent-urban');

    if (!agentShowUrbanLayer || !agentImpactData?.layers?.urban?.tile_url) return;

    map.addSource('agent-urban', {
      type: 'raster',
      tiles: [agentImpactData.layers.urban.tile_url],
      tileSize: 256,
    });
    map.addLayer({
      id: 'agent-urban',
      type: 'raster',
      source: 'agent-urban',
      paint: { 'raster-opacity': 0.7 },
    });

    const lifecycle = createLayerTileLifecycle(map, 'urban');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowUrbanLayer, createLayerTileLifecycle]);

  // ========== Effect E: Land Cover Overlay ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    if (map.getLayer('agent-landcover')) map.removeLayer('agent-landcover');
    if (map.getSource('agent-landcover')) map.removeSource('agent-landcover');

    if (!agentShowLandcoverLayer || !agentImpactData?.layers?.landcover?.tile_url) return;

    map.addSource('agent-landcover', {
      type: 'raster',
      tiles: [agentImpactData.layers.landcover.tile_url],
      tileSize: 256,
    });
    map.addLayer({
      id: 'agent-landcover',
      type: 'raster',
      source: 'agent-landcover',
      paint: { 'raster-opacity': 0.7 },
    });

    const lifecycle = createLayerTileLifecycle(map, 'landcover');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowLandcoverLayer, createLayerTileLifecycle]);

  const displayedAoi = isAoiEditing
    ? null
    : appMode === 'agent'
    ? selectedAOI || buildAoiFromAgentState(floodAgentState, {
        source: 'agent_geocode',
        label: floodAgentState?.location || 'Agent-derived boundary',
      })
    : selectedAOI;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const sourceId = AOI_SOURCE_ID;
    const layerId = 'analysis-aoi-fill';
    const outlineLayerId = 'analysis-aoi-outline';

    removeAoiLayers(map);

    if (!displayedAoi?.geojson) {
      lastFittedAoiRef.current = null;
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

    const boundsKey = JSON.stringify(displayedAoi.bounds || {});
    if (displayedAoi.bounds && boundsKey !== lastFittedAoiRef.current) {
      const { west, south, east, north } = displayedAoi.bounds;
      map.fitBounds([[west, south], [east, north]], { padding: 50 });
      lastFittedAoiRef.current = boundsKey;
    }
  }, [displayedAoi, removeAoiLayers]);

  return (
    <div 
      ref={mapContainerRef} 
      id="map" 
      className="map"
      style={{ width: '100%', height: '100%' }}
    />
  );
}

export default MapContainer;
