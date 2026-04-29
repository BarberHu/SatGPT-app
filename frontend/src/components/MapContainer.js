import React, { useEffect, useRef, useCallback, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { useAppContext } from '../context/AppContext';
import {
  buildAoiFromDrawFeature,
  buildAoiFromDrawFeatures,
  buildAoiFromGridSelection,
  getDrawFeaturesFromAoi,
} from '../utils/aoi';
import { buildAoiFromBusinessLayerRecord } from '../utils/businessLayerStore';
import {
  buildCatalogMapLayerDefinition,
  getCatalogMapLayerId,
  isCatalogMapLayerId,
} from '../utils/catalogLayers';

// Mapbox access token - should be set via environment variable
mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_KEY || '';

const DEFAULT_CENTER = [102.0, 16.5];
const DEFAULT_ZOOM = 5;

// Custom Mapbox style (same as original project)
const MAPBOX_STYLE = 'mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp';
const ASK_LAYER_NAMES = ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
const AGENT_RASTER_LAYER_NAMES = ['populationDensity', 'lclu', 'soilTexture', 'healthCareAccess'];
const AGENT_RASTER_LAYER_IDS = AGENT_RASTER_LAYER_NAMES.map((layerName) => `agent-raster-${layerName}`);
const AGENT_BASE_LAYER_IDS = [
  'agent-s2-pre', 'agent-s2-peek', 'agent-s2-after',
  'agent-s1-pre', 'agent-s1-peek', 'agent-s1-after',
];
const AGENT_ANALYSIS_LAYER_IDS = [
  'agent-flood-detection', 'agent-population', 'agent-urban', 'agent-landcover',
];
const AGENT_OVERLAY_LAYER_IDS = [...AGENT_ANALYSIS_LAYER_IDS, ...AGENT_RASTER_LAYER_IDS];
const AGENT_SOURCE_IDS = [
  ...AGENT_BASE_LAYER_IDS,
  ...AGENT_OVERLAY_LAYER_IDS,
];
const AOI_SOURCE_ID = 'analysis-aoi';
const AOI_LAYER_IDS = ['analysis-aoi-fill', 'analysis-aoi-outline'];
const BUSINESS_LAYER_SOURCE_ID = 'business-layer-scopes';
const BUSINESS_LAYER_LAYER_IDS = ['business-layer-scopes-fill', 'business-layer-scopes-outline'];
const DRAW_BLUE = '#2563eb';
const DRAW_ORANGE = '#f97316';
const DRAW_WHITE = '#ffffff';
const formatCoordinatePart = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(6) : '';
};
const buildBoundsSignature = (bounds) => {
  if (!bounds) {
    return 'no-bounds';
  }

  return [
    formatCoordinatePart(bounds.west),
    formatCoordinatePart(bounds.south),
    formatCoordinatePart(bounds.east),
    formatCoordinatePart(bounds.north),
  ].join(':');
};
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
  const utilityControlRef = useRef(null);
  const gridClickButtonRef = useRef(null);
  const lastFittedAoiRef = useRef(null);
  const lastConfirmationFocusRef = useRef(null);
  const gridClickEnabledRef = useRef(true);
  const programmaticDrawMutationRef = useRef(false);
  const isAoiEditingRef = useRef(false);
  const editableGeojsonRef = useRef(null);
  const transientWarningTimeoutRef = useRef(null);
  const [isPolygonDrawMode, setIsPolygonDrawMode] = useState(false);
  const [pendingSpatialScopeSave, setPendingSpatialScopeSave] = useState(null);
  
  const {
    setMapInstance,
    setSelectedGridCords,
    setSelectedAOI,
    setDraftAOI,
    selectedAOI,
    draftAOI,
    aoiClearVersion,
    gridClickEnabled,
    setGridClickEnabled,
    isAoiEditing,
    aoiEditorMode,
    setWarning,
    resetAskSession,
    resetAgentSession,
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
    agentShowBaseImagery,
    agentBaseImageryVisibility,
    agentShowFloodDetection,
    agentShowPopulationLayer,
    agentShowUrbanLayer,
    agentShowLandcoverLayer,
    agentRasterLayerVisibility,
    agentImpactData,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentLayerOrder,
    setAgentLayerLoading,
    setAgentTileError,
    businessLayers,
    agentVisualResetVersion,
    registerBusinessLayerFromAoi,
    removeBusinessLayerRecord,
    clearAgentVisualState,
  } = useAppContext();

  // Track if map is initialized
  const mapInitialized = useRef(false);
  const agentLayerOrderRef = useRef(agentLayerOrder);
  const agentRecommendedLayerDataRef = useRef(agentRecommendedLayerData);
  const agentRasterTileUrlRef = useRef({});
  const agentRasterLayerVisibilityRef = useRef(agentRasterLayerVisibility);
  const appModeRef = useRef(appMode);
  const layerDataRef = useRef(layerData);
  const syncAgentRasterLayersRef = useRef(null);

  agentLayerOrderRef.current = agentLayerOrder;
  agentRecommendedLayerDataRef.current = agentRecommendedLayerData;
  agentRasterLayerVisibilityRef.current = agentRasterLayerVisibility;
  appModeRef.current = appMode;
  layerDataRef.current = layerData;

  const clearTransientWarningTimer = useCallback(() => {
    if (transientWarningTimeoutRef.current) {
      window.clearTimeout(transientWarningTimeoutRef.current);
      transientWarningTimeoutRef.current = null;
    }
  }, []);

  const showTransientWarning = useCallback((message, timeoutMs = 1800) => {
    clearTransientWarningTimer();
    setWarning(message);

    if (!message) {
      return;
    }

    transientWarningTimeoutRef.current = window.setTimeout(() => {
      setWarning((currentWarning) => (currentWarning === message ? '' : currentWarning));
      transientWarningTimeoutRef.current = null;
    }, timeoutMs);
  }, [clearTransientWarningTimer, setWarning]);

  useEffect(() => {
    gridClickEnabledRef.current = gridClickEnabled;
  }, [gridClickEnabled]);

  useEffect(() => () => {
    clearTransientWarningTimer();
  }, [clearTransientWarningTimer]);

  useEffect(() => {
    const button = gridClickButtonRef.current;
    if (!button) {
      return;
    }

    const disabled = isAoiEditing || isPolygonDrawMode;
    button.classList.toggle('active', gridClickEnabled && !disabled);
    button.classList.toggle('disabled', disabled);
    button.setAttribute('aria-pressed', gridClickEnabled ? 'true' : 'false');
    button.title = disabled
      ? 'Drawing is in progress, so map click loading is temporarily disabled.'
      : (gridClickEnabled ? 'Click map grids to load data.' : 'Map grid click loading is off.');
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

  useEffect(() => {
    agentLayerOrderRef.current = agentLayerOrder;
  }, [agentLayerOrder]);

  useEffect(() => {
    agentRecommendedLayerDataRef.current = agentRecommendedLayerData;
  }, [agentRecommendedLayerData]);

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

  const removeAskRasterSiblings = useCallback((map, layerNames = []) => {
    (layerNames || []).forEach((layerName) => {
      const askLayerId = `${layerName}-layer`;
      if (map.getLayer(askLayerId)) {
        map.removeLayer(askLayerId);
      }
      if (map.getSource(layerName)) {
        map.removeSource(layerName);
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

    agentRasterTileUrlRef.current = {};
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

  const removeBusinessLayerMapLayers = useCallback((map) => {
    BUSINESS_LAYER_LAYER_IDS.forEach((id) => {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    });

    if (map.getSource(BUSINESS_LAYER_SOURCE_ID)) {
      map.removeSource(BUSINESS_LAYER_SOURCE_ID);
    }
  }, []);

  const removeCatalogMapLayers = useCallback((map) => {
    (map.getStyle()?.layers || [])
      .map((layer) => layer.id)
      .filter((id) => isCatalogMapLayerId(id))
      .forEach((id) => {
        if (map.getLayer(id)) {
          map.removeLayer(id);
        }
        if (map.getSource(id)) {
          map.removeSource(id);
        }
      });
  }, []);

  const getExistingLayerBands = useCallback((map) => {
    const styleLayers = map.getStyle()?.layers || [];
    const styleLayerIds = styleLayers.map((layer) => layer.id);
    const existingLayerIds = new Set(styleLayerIds);
    const catalogLayers = styleLayerIds.filter((id) => isCatalogMapLayerId(id));
    const orderIndex = new Map((agentLayerOrderRef.current || []).map((id, index) => [id, index]));
    const sortByLayerOrder = (ids) => [...ids].sort((left, right) => {
      const leftIndex = orderIndex.has(left) ? orderIndex.get(left) : Number.MAX_SAFE_INTEGER;
      const rightIndex = orderIndex.has(right) ? orderIndex.get(right) : Number.MAX_SAFE_INTEGER;

      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return AGENT_BASE_LAYER_IDS.indexOf(left) - AGENT_BASE_LAYER_IDS.indexOf(right);
    });
    const agentOverlayCandidates = [
      ...(agentLayerOrderRef.current || []),
      ...AGENT_OVERLAY_LAYER_IDS,
      ...Object.keys(agentRecommendedLayerDataRef.current || {}).map(getCatalogMapLayerId),
      ...catalogLayers,
    ].filter((id) => !AGENT_BASE_LAYER_IDS.includes(id));
    const agentOverlayLayers = Array.from(new Set(agentOverlayCandidates))
      .filter((id) => existingLayerIds.has(id));

    return {
      gridLayers: ['grid_cell-layer'].filter((id) => existingLayerIds.has(id)),
      baseImageryLayers: sortByLayerOrder(AGENT_BASE_LAYER_IDS.filter((id) => existingLayerIds.has(id))),
      analysisLayers: [
        ...ASK_LAYER_NAMES.map((layerName) => `${layerName}-layer`),
      ].filter((id) => existingLayerIds.has(id)),
      agentOverlayLayers,
      businessLayers: BUSINESS_LAYER_LAYER_IDS.filter((id) => existingLayerIds.has(id)),
      aoiLayers: AOI_LAYER_IDS.filter((id) => existingLayerIds.has(id)),
      drawLayers: styleLayerIds.filter((id) => id.startsWith('gl-draw-')),
    };
  }, []);

  const promoteDrawLayers = useCallback((map) => {
    if (!map || !map.isStyleLoaded()) return;

    const { drawLayers } = getExistingLayerBands(map);
    drawLayers.forEach((id) => {
      if (!map.getLayer(id)) return;
      try {
        map.moveLayer(id);
      } catch (error) {
        console.warn(`Failed to promote draw layer ${id}:`, error);
      }
    });
  }, [getExistingLayerBands]);

  const reconcileLayerOrder = useCallback((map) => {
    if (!map || !map.isStyleLoaded()) return;

    const {
      gridLayers,
      baseImageryLayers,
      analysisLayers,
      agentOverlayLayers,
      businessLayers,
      aoiLayers,
      drawLayers,
    } = getExistingLayerBands(map);

    const orderedFromTopToBottom = [
      ...drawLayers.slice().reverse(),
      ...aoiLayers.slice().reverse(),
      ...businessLayers.slice().reverse(),
      ...agentOverlayLayers,
      ...analysisLayers.slice().reverse(),
      ...gridLayers.slice().reverse(),
      ...baseImageryLayers.slice().reverse(),
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

  const getInsertBeforeId = useCallback((map, layerId) => {
    if (!map || !map.isStyleLoaded() || !layerId) {
      return undefined;
    }

    const bands = getExistingLayerBands(map);
    const withExtra = (items = []) => (items.includes(layerId) ? items : [...items, layerId]);
    const orderIndex = new Map((agentLayerOrderRef.current || []).map((id, index) => [id, index]));
    const orderBaseLayers = (ids = []) => Array.from(new Set(ids)).sort((left, right) => {
      const leftIndex = orderIndex.has(left) ? orderIndex.get(left) : Number.MAX_SAFE_INTEGER;
      const rightIndex = orderIndex.has(right) ? orderIndex.get(right) : Number.MAX_SAFE_INTEGER;

      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }

      return AGENT_BASE_LAYER_IDS.indexOf(left) - AGENT_BASE_LAYER_IDS.indexOf(right);
    });

    const overlayCandidates = [
      ...(agentLayerOrderRef.current || []),
      ...AGENT_OVERLAY_LAYER_IDS,
      ...Object.keys(agentRecommendedLayerDataRef.current || {}).map(getCatalogMapLayerId),
    ].filter((id) => !AGENT_BASE_LAYER_IDS.includes(id));
    const overlayOrdered = Array.from(new Set(
      isCatalogMapLayerId(layerId) || AGENT_OVERLAY_LAYER_IDS.includes(layerId)
        ? [...overlayCandidates, layerId]
        : overlayCandidates
    ))
      .filter((id) => id === layerId || map.getLayer(id));

    const desiredTopToBottom = [
      ...bands.drawLayers.slice().reverse(),
      ...bands.aoiLayers.slice().reverse(),
      ...bands.businessLayers.slice().reverse(),
      ...overlayOrdered,
      ...bands.analysisLayers.slice().reverse(),
      ...bands.gridLayers.slice().reverse(),
      ...(
        AGENT_BASE_LAYER_IDS.includes(layerId)
          ? orderBaseLayers(withExtra(bands.baseImageryLayers)).slice().reverse()
          : bands.baseImageryLayers.slice().reverse()
      ),
    ];

    const targetIndex = desiredTopToBottom.indexOf(layerId);
    if (targetIndex <= 0) {
      return undefined;
    }

    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const candidateId = desiredTopToBottom[index];
      if (candidateId !== layerId && map.getLayer(candidateId)) {
        return candidateId;
      }
    }

    return undefined;
  }, [getExistingLayerBands]);

  const syncAgentRasterLayers = useCallback((map) => {
    if (!map || !map.isStyleLoaded()) {
      return false;
    }

    const currentAppMode = appModeRef.current;
    const currentLayerData = layerDataRef.current || {};
    const currentRasterVisibility = agentRasterLayerVisibilityRef.current || {};
    const currentLayerOrder = agentLayerOrderRef.current || [];

    if (currentAppMode === 'agent') {
      removeAskRasterSiblings(map, AGENT_RASTER_LAYER_NAMES);
    }

    const rasterOrderIndex = new Map(
      currentLayerOrder.map((layerId, index) => [layerId, index])
    );
    const orderedRasterNames = [...AGENT_RASTER_LAYER_NAMES].sort((left, right) => {
      const leftId = `agent-raster-${left}`;
      const rightId = `agent-raster-${right}`;
      const leftIndex = rasterOrderIndex.has(leftId) ? rasterOrderIndex.get(leftId) : Number.MAX_SAFE_INTEGER;
      const rightIndex = rasterOrderIndex.has(rightId) ? rasterOrderIndex.get(rightId) : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });

    orderedRasterNames.forEach((layerName) => {
      const mapLayerId = `agent-raster-${layerName}`;
      const descriptor = currentAppMode === 'agent' ? currentLayerData?.[layerName] : null;
      const nextTileUrl = currentRasterVisibility?.[layerName] && descriptor?.tileUrl
        ? descriptor.tileUrl
        : null;
      const previousTileUrl = agentRasterTileUrlRef.current?.[layerName] || null;

      if (!nextTileUrl) {
        if (map.getLayer(mapLayerId)) {
          map.removeLayer(mapLayerId);
        }
        if (map.getSource(mapLayerId)) {
          map.removeSource(mapLayerId);
        }
        agentRasterTileUrlRef.current[layerName] = null;
        return;
      }

      if (previousTileUrl === nextTileUrl && map.getLayer(mapLayerId) && map.getSource(mapLayerId)) {
        return;
      }

      if (map.getLayer(mapLayerId)) {
        map.removeLayer(mapLayerId);
      }
      if (map.getSource(mapLayerId)) {
        map.removeSource(mapLayerId);
      }

      map.addSource(mapLayerId, {
        type: 'raster',
        tiles: [nextTileUrl],
        tileSize: 256,
      });

      const rasterLayerDefinition = {
        id: mapLayerId,
        type: 'raster',
        source: mapLayerId,
        paint: {
          'raster-opacity': 1,
        },
      };
      const rasterBeforeId = getInsertBeforeId(map, mapLayerId);
      if (rasterBeforeId) {
        map.addLayer(rasterLayerDefinition, rasterBeforeId);
      } else {
        map.addLayer(rasterLayerDefinition);
      }
      agentRasterTileUrlRef.current[layerName] = nextTileUrl;
    });

    reconcileLayerOrder(map);
    return true;
  }, [
    getInsertBeforeId,
    reconcileLayerOrder,
    removeAskRasterSiblings,
  ]);

  useEffect(() => {
    syncAgentRasterLayersRef.current = syncAgentRasterLayers;
  }, [syncAgentRasterLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    window.requestAnimationFrame(() => reconcileLayerOrder(map));
  }, [
    agentLayerOrder,
    agentRecommendedLayerVisibility,
    agentBaseImageryVisibility,
    agentShowBaseImagery,
    agentShowFloodDetection,
    agentShowPopulationLayer,
    agentShowUrbanLayer,
    agentShowLandcoverLayer,
    agentRasterLayerVisibility,
    reconcileLayerOrder,
  ]);

  const loadGridLayer = useCallback((map) => {
    map.addSource('grid_cell', {
      type: 'geojson',
      data: '/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson',
    });

    map.addLayer({
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
        reconcileLayerOrder(map);
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
  }, [reconcileLayerOrder, removeAgentLayers, removeAskLayers, resetAgentSession, resetAskSession, setDraftAOI, setSelectedAOI, setSelectedGridCords]);

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
        controls: {
          polygon: true,
          trash: true,
        },
        styles: DRAW_STYLES,
      });
      map.addControl(drawRef.current, 'top-right');

      const utilityControl = {
        onAdd() {
          const container = document.createElement('div');
          container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group satgpt-map-utility-group';

          const gridButton = document.createElement('button');
          gridButton.type = 'button';
          gridButton.className = 'satgpt-map-toggle-btn';
          gridButton.innerHTML = '<i class="fa fa-crosshairs" aria-hidden="true"></i>';
          gridButton.setAttribute('aria-label', 'Toggle map click loading');
          gridButton.setAttribute('title', 'Toggle map click loading');
          gridButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (isAoiEditingRef.current || drawRef.current?.getMode?.() === 'draw_polygon') {
              return;
            }

            setGridClickEnabled((previous) => !previous);
          };

          const disabled = isAoiEditingRef.current || drawRef.current?.getMode?.() === 'draw_polygon';
          gridButton.classList.toggle('active', gridClickEnabledRef.current && !disabled);
          gridButton.classList.toggle('disabled', disabled);
          gridButton.setAttribute('aria-pressed', gridClickEnabledRef.current ? 'true' : 'false');

          container.appendChild(gridButton);
          gridClickButtonRef.current = gridButton;
          return container;
        },
        onRemove() {
          if (gridClickButtonRef.current) {
            gridClickButtonRef.current.onclick = null;
          }
          gridClickButtonRef.current = null;
        },
      };

      map.addControl(utilityControl, 'top-right');
      utilityControlRef.current = utilityControl;
      loadGridLayer(map);
      window.requestAnimationFrame(() => reconcileLayerOrder(map));
    });

    const handleStyleData = () => {
      syncAgentRasterLayersRef.current?.(map);
      window.requestAnimationFrame(() => reconcileLayerOrder(map));
    };
    map.on('styledata', handleStyleData);

    return () => {
      map.off('styledata', handleStyleData);
      if (mapRef.current) {
        if (utilityControlRef.current) {
          map.removeControl(utilityControlRef.current);
          utilityControlRef.current = null;
        }
        drawRef.current = null;
        mapRef.current.remove();
        mapRef.current = null;
        mapInitialized.current = false;
      }
    };
  }, [loadGridLayer, reconcileLayerOrder, setGridClickEnabled, setMapInstance]);

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

  const getDrawScopeLabel = useCallback((featureId) => {
    const existing = businessLayers.find((layer) => String(layer.id) === String(featureId));
    if (existing?.label) {
      return existing.label;
    }

    const drawCount = businessLayers.filter((layer) => (
      String(layer.origin || layer.source || '').toLowerCase() === 'draw'
      || String(layer.source || '').toLowerCase() === 'draw'
      || String(layer.source || '').toLowerCase() === 'edited'
    )).length;

    return `draw_scope_${drawCount + 1}`;
  }, [businessLayers]);

  const syncAgentDrawFeature = useCallback((feature, { shouldFit = false } = {}) => {
    const featureId = String(feature?.id || '').trim();
    if (!featureId || feature?.geometry?.type !== 'Polygon') {
      return null;
    }

    const nextAoi = buildAoiFromDrawFeature(feature, {
      id: featureId,
      source: 'draw',
      origin: 'draw',
      label: getDrawScopeLabel(featureId),
    });

    if (!nextAoi) {
      return null;
    }

    clearAgentVisualState();
    setSelectedGridCords(null);
    setSelectedAOI(nextAoi);
    registerBusinessLayerFromAoi(nextAoi, {
      id: nextAoi.id,
      label: nextAoi.label,
      source: 'draw',
      origin: 'draw',
      markActive: true,
    });
    setWarning('');

    if (shouldFit) {
      fitAoiBounds(nextAoi, { force: true, padding: 56, duration: 500 });
    }

    return nextAoi;
  }, [
    fitAoiBounds,
    clearAgentVisualState,
    getDrawScopeLabel,
    registerBusinessLayerFromAoi,
    setSelectedAOI,
    setSelectedGridCords,
    setWarning,
  ]);

  const handleDiscardPendingSpatialScope = useCallback(() => {
    const draw = drawRef.current;
    if (!draw || !pendingSpatialScopeSave?.featureIds?.length) {
      setPendingSpatialScopeSave(null);
      return;
    }

    draw.delete(pendingSpatialScopeSave.featureIds);
    setPendingSpatialScopeSave(null);
    showTransientWarning('Spatial scope was discarded.');
    window.requestAnimationFrame(() => {
      try {
        draw.changeMode('draw_polygon');
      } catch (error) {
        console.warn('Failed to resume polygon drawing after discard:', error);
      }
    });
  }, [pendingSpatialScopeSave, showTransientWarning]);

  const handleConfirmPendingSpatialScope = useCallback(() => {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw || !pendingSpatialScopeSave?.featureIds?.length) {
      setPendingSpatialScopeSave(null);
      return;
    }

    pendingSpatialScopeSave.featureIds.forEach((featureId, index) => {
      const feature = draw.get(featureId);
      if (feature?.geometry?.type === 'Polygon') {
        syncAgentDrawFeature(feature, { shouldFit: index === 0 });
      }
    });

    setPendingSpatialScopeSave(null);
    setWarning('');
    if (draw) {
      runProgrammaticDrawMutation(() => {
        draw.deleteAll();
        draw.changeMode('simple_select');
      });
    }
    if (map) {
      promoteDrawLayers(map);
    }
  }, [
    pendingSpatialScopeSave,
    promoteDrawLayers,
    runProgrammaticDrawMutation,
    setWarning,
    syncAgentDrawFeature,
  ]);

  const syncDraftFromFeatures = useCallback((features) => {
    const nextDraftAoi = buildAoiFromDrawFeatures(features, {
      source: aoiEditorMode === 'edit' ? 'edited' : 'draw',
      label: selectedAOI?.label || 'Manual scope',
    });

    if (!nextDraftAoi) {
      setDraftAOI(null);
      setWarning('Current drawing result is not a valid spatial scope. Please redraw the polygon.');
      return;
    }

    setDraftAOI(nextDraftAoi);
    setWarning('');
  }, [aoiEditorMode, selectedAOI, setDraftAOI, setWarning]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw) return;

    const syncDrawModeState = (event) => {
      const nextMode = event?.mode || draw.getMode?.() || 'simple_select';
      const drawingPolygon = nextMode === 'draw_polygon';
      setIsPolygonDrawMode(drawingPolygon);
      if (drawingPolygon && gridClickEnabledRef.current) {
        setGridClickEnabled(false);
      }
    };

    const handleCreate = (event) => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      if (appMode === 'agent' && !isAoiEditingRef.current) {
        const createdFeatures = (event.features || [])
          .filter((feature) => feature.geometry?.type === 'Polygon');

        if (!createdFeatures.length) {
          setWarning('Please draw a valid polygon spatial scope.');
          return;
        }
        setPendingSpatialScopeSave({
          featureIds: createdFeatures.map((feature) => feature.id).filter(Boolean),
          featureCount: createdFeatures.length,
        });
        setWarning('');
        promoteDrawLayers(map);
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

    const handleUpdate = (event) => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      if (appMode === 'agent' && !isAoiEditingRef.current) {
        (event.features || [])
          .filter((feature) => feature.geometry?.type === 'Polygon')
          .forEach((feature) => {
            syncAgentDrawFeature(feature);
          });
        promoteDrawLayers(map);
        return;
      }

      syncDraftFromFeatures(draw.getAll().features || []);
      promoteDrawLayers(map);
    };

    const handleDelete = (event) => {
      if (programmaticDrawMutationRef.current) {
        return;
      }

      if (appMode === 'agent' && !isAoiEditingRef.current) {
        const deletedIds = (event.features || [])
          .map((feature) => String(feature?.id || '').trim())
          .filter(Boolean);

        if (deletedIds.length) {
          if (pendingSpatialScopeSave?.featureIds?.some((featureId) => deletedIds.includes(String(featureId)))) {
            setPendingSpatialScopeSave(null);
          }
          const deletedActive = deletedIds.includes(String(selectedAOI?.id || ''));
          deletedIds.forEach((layerId) => {
            removeBusinessLayerRecord(layerId);
          });

          if (deletedActive) {
            const fallbackRecord = businessLayers.find((layer) => !deletedIds.includes(String(layer.id || '')));
            setSelectedAOI(fallbackRecord ? buildAoiFromBusinessLayerRecord(fallbackRecord) : null);
          }
        }

        setDraftAOI(null);
        setWarning('');
        promoteDrawLayers(map);
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

    map.on('draw.create', handleCreate);
    map.on('draw.update', handleUpdate);
    map.on('draw.delete', handleDelete);
    map.on('draw.modechange', syncDrawModeState);
    syncDrawModeState({ mode: draw.getMode?.() || 'simple_select' });

    return () => {
      map.off('draw.create', handleCreate);
      map.off('draw.update', handleUpdate);
      map.off('draw.delete', handleDelete);
      map.off('draw.modechange', syncDrawModeState);
    };
  }, [
    appMode,
    businessLayers,
    gridClickEnabled,
    pendingSpatialScopeSave?.featureIds,
    promoteDrawLayers,
    removeBusinessLayerRecord,
    selectedAOI?.id,
    setGridClickEnabled,
    setDraftAOI,
    setPendingSpatialScopeSave,
    setSelectedAOI,
    setWarning,
    syncAgentDrawFeature,
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
        window.requestAnimationFrame(() => promoteDrawLayers(map));
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
        window.requestAnimationFrame(() => promoteDrawLayers(map));
      }
    }
  }, [aoiEditorMode, promoteDrawLayers, reconcileLayerOrder, runProgrammaticDrawMutation, setDraftAOI, setWarning]);

  // Update EE layers when layer data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (appMode !== 'ask') {
      removeAskLayers(map);
      reconcileLayerOrder(map);
      return;
    }

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

    reconcileLayerOrder(map);
  }, [appMode, layerData, layerOpacity, layerVisibility, reconcileLayerOrder, removeAskLayers]);

  // Update layer visibility and opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (appMode !== 'ask') {
      removeAskLayers(map);
      return;
    }

    ASK_LAYER_NAMES.forEach((layerName) => {
      if (map.getLayer(`${layerName}-layer`)) {
        const opacity = layerVisibility[layerName] ? layerOpacity[layerName] : 0;
        map.setPaintProperty(`${layerName}-layer`, 'raster-opacity', opacity);
      }
    });
  }, [appMode, layerVisibility, layerOpacity, removeAskLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (appMode === 'ask') {
      removeAgentLayers(map);
    } else {
      removeAskLayers(map);
    }

    reconcileLayerOrder(map);
  }, [appMode, reconcileLayerOrder, removeAgentLayers, removeAskLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (appMode === 'ask') {
      removeAskLayers(map);
    } else {
      removeAgentLayers(map);
      setAgentTileError(null);
    }

    reconcileLayerOrder(map);
  }, [appMode, selectedAOI, reconcileLayerOrder, removeAgentLayers, removeAskLayers, setAgentTileError]);

  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map) return;

    removeAskLayers(map);
    removeAgentLayers(map);
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
  }, [aoiClearVersion, reconcileLayerOrder, removeAgentLayers, removeAskLayers, removeAoiLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    removeAgentLayers(map);
    removeCatalogMapLayers(map);
    setAgentTileError(null);
    reconcileLayerOrder(map);
  }, [agentVisualResetVersion, reconcileLayerOrder, removeAgentLayers, removeCatalogMapLayers, setAgentTileError]);

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

    if (!agentImagery || !agentShowBaseImagery) return;

    setAgentTileError(null);

    const periodKey = agentSelectedPeriod;
    const periodData = agentImagery[periodKey];
    const visibleBaseTypes = ['sentinel2', 'sentinel1'].filter((type) => (
      agentBaseImageryVisibility?.[type]
      && periodData?.[type]?.tile_url
    ));

    if (!visibleBaseTypes.length) return;

    visibleBaseTypes.forEach((typeKey) => {
      const sourceId = `agent-${typeKey === 'sentinel2' ? 's2' : 's1'}-${periodKey.replace('_date', '')}`;
      map.addSource(sourceId, {
        type: 'raster',
        tiles: [periodData[typeKey].tile_url],
        tileSize: 256,
      });
      const imageryLayerDefinition = {
        id: sourceId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': 1 },
      };
      const imageryBeforeId = getInsertBeforeId(map, sourceId);
      if (imageryBeforeId) {
        map.addLayer(imageryLayerDefinition, imageryBeforeId);
      } else {
        map.addLayer(imageryLayerDefinition);
      }
    });
    reconcileLayerOrder(map);

    // Track tile errors (only on base imagery since it's the primary GEE layer)
    let tileErrorCount = 0;
    const onTileError = (e) => {
      if (e?.error?.status >= 400 || e?.error?.message?.includes('HTTP') || e?.type === 'error') {
        tileErrorCount++;
        console.warn('Tile load error:', e?.sourceId || 'unknown', e?.error?.message || '');
      }
    };
    map.on('error', onTileError);

    const loadingUpdates = visibleBaseTypes.reduce((updates, typeKey) => ({
      ...updates,
      [`base-imagery-${typeKey}`]: true,
    }), { 'base-imagery': true });
    setAgentLayerLoading(prev => ({ ...prev, ...loadingUpdates }));

    let resolved = false;
    const finish = (isTimeout) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const nextLoadingUpdates = visibleBaseTypes.reduce((updates, typeKey) => ({
        ...updates,
        [`base-imagery-${typeKey}`]: false,
      }), { 'base-imagery': false });
      setAgentLayerLoading(prev => ({ ...prev, ...nextLoadingUpdates }));
      if (tileErrorCount > 0) {
        console.warn(`${tileErrorCount} tile(s) failed to load.`);
        setAgentTileError({
          count: tileErrorCount,
          message: isTimeout
            ? 'Map tiles timed out. The GEE imagery URL may have expired. Try re-running the analysis.'
            : 'Some map tiles failed to load. The imagery URL may have expired. Try re-running the analysis.',
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
      const nextLoadingUpdates = visibleBaseTypes.reduce((updates, typeKey) => ({
        ...updates,
        [`base-imagery-${typeKey}`]: false,
      }), { 'base-imagery': false });
      setAgentLayerLoading(prev => ({ ...prev, ...nextLoadingUpdates }));
      map.off('error', onTileError);
      map.off('idle', finish);
      clearTimeout(timeout);
    };
  }, [agentBaseImageryVisibility, agentImagery, agentShowBaseImagery, appMode, agentSelectedPeriod, getInsertBeforeId, reconcileLayerOrder, setAgentLayerLoading, setAgentTileError]);

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
    const floodLayerDefinition = {
      id: 'agent-flood-detection',
      type: 'raster',
      source: 'agent-flood-detection',
      paint: { 'raster-opacity': 0.7 },
    };
    const floodBeforeId = getInsertBeforeId(map, 'agent-flood-detection');
    if (floodBeforeId) {
      map.addLayer(floodLayerDefinition, floodBeforeId);
    } else {
      map.addLayer(floodLayerDefinition);
    }
    reconcileLayerOrder(map);

    const lifecycle = createLayerTileLifecycle(map, 'flood-detection');
    return lifecycle.cleanup;
  }, [agentImagery, appMode, agentShowFloodDetection, createLayerTileLifecycle, getInsertBeforeId, reconcileLayerOrder]);

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
    const populationLayerDefinition = {
      id: 'agent-population',
      type: 'raster',
      source: 'agent-population',
      paint: { 'raster-opacity': 0.7 },
    };
    const populationBeforeId = getInsertBeforeId(map, 'agent-population');
    if (populationBeforeId) {
      map.addLayer(populationLayerDefinition, populationBeforeId);
    } else {
      map.addLayer(populationLayerDefinition);
    }
    reconcileLayerOrder(map);

    const lifecycle = createLayerTileLifecycle(map, 'population');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowPopulationLayer, createLayerTileLifecycle, getInsertBeforeId, reconcileLayerOrder]);

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
    const urbanLayerDefinition = {
      id: 'agent-urban',
      type: 'raster',
      source: 'agent-urban',
      paint: { 'raster-opacity': 0.7 },
    };
    const urbanBeforeId = getInsertBeforeId(map, 'agent-urban');
    if (urbanBeforeId) {
      map.addLayer(urbanLayerDefinition, urbanBeforeId);
    } else {
      map.addLayer(urbanLayerDefinition);
    }
    reconcileLayerOrder(map);

    const lifecycle = createLayerTileLifecycle(map, 'urban');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowUrbanLayer, createLayerTileLifecycle, getInsertBeforeId, reconcileLayerOrder]);

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
    const landcoverLayerDefinition = {
      id: 'agent-landcover',
      type: 'raster',
      source: 'agent-landcover',
      paint: { 'raster-opacity': 0.7 },
    };
    const landcoverBeforeId = getInsertBeforeId(map, 'agent-landcover');
    if (landcoverBeforeId) {
      map.addLayer(landcoverLayerDefinition, landcoverBeforeId);
    } else {
      map.addLayer(landcoverLayerDefinition);
    }
    reconcileLayerOrder(map);

    const lifecycle = createLayerTileLifecycle(map, 'landcover');
    return lifecycle.cleanup;
  }, [agentImpactData, appMode, agentShowLandcoverLayer, createLayerTileLifecycle, getInsertBeforeId, reconcileLayerOrder]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    const runSync = () => {
      syncAgentRasterLayers(map);
      window.requestAnimationFrame(() => {
        if (mapRef.current === map && map.isStyleLoaded()) {
          syncAgentRasterLayers(map);
        }
      });
    };

    if (syncAgentRasterLayers(map)) {
      window.requestAnimationFrame(() => {
        if (mapRef.current === map && map.isStyleLoaded()) {
          syncAgentRasterLayers(map);
        }
      });
      return undefined;
    }

    map.once('load', runSync);
    map.once('styledata', runSync);
    return () => {
      map.off('load', runSync);
      map.off('styledata', runSync);
    };
  }, [
    agentLayerOrder,
    agentRasterLayerVisibility,
    appMode,
    layerData,
    syncAgentRasterLayers,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (appMode !== 'agent') {
      (map.getStyle()?.layers || [])
        .map((layer) => layer.id)
        .filter((id) => isCatalogMapLayerId(id))
        .forEach((id) => {
          if (map.getLayer(id)) {
            map.removeLayer(id);
          }
          if (map.getSource(id)) {
            map.removeSource(id);
          }
        });
      return;
    }

    const layerEntries = Object.entries(agentRecommendedLayerData || {});
    const activeLayerIds = new Set();
    const tileLifecycleCleanups = [];

    layerEntries.forEach(([layerId, descriptor]) => {
      const mapDefinition = buildCatalogMapLayerDefinition(layerId, descriptor);
      const mapLayerId = mapDefinition?.mapLayerId;

      if (!mapLayerId) {
        return;
      }

      activeLayerIds.add(mapLayerId);

      if (map.getLayer(mapLayerId)) {
        map.removeLayer(mapLayerId);
      }
      if (map.getSource(mapLayerId)) {
        map.removeSource(mapLayerId);
      }

      if (!descriptor?.tile_url || !agentRecommendedLayerVisibility?.[layerId]) {
        return;
      }

      map.addSource(mapLayerId, mapDefinition.source);
      const catalogLayerDefinition = {
        ...mapDefinition.layer,
        source: mapLayerId,
      };
      const catalogBeforeId = getInsertBeforeId(map, mapLayerId);
      if (catalogBeforeId) {
        map.addLayer(catalogLayerDefinition, catalogBeforeId);
      } else {
        map.addLayer(catalogLayerDefinition);
      }
      tileLifecycleCleanups.push(createLayerTileLifecycle(map, layerId).cleanup);
    });

    (map.getStyle()?.layers || [])
      .map((layer) => layer.id)
      .filter((id) => isCatalogMapLayerId(id) && !activeLayerIds.has(id))
      .forEach((id) => {
        if (map.getLayer(id)) {
          map.removeLayer(id);
        }
        if (map.getSource(id)) {
          map.removeSource(id);
        }
      });

    reconcileLayerOrder(map);

    return () => {
      tileLifecycleCleanups.forEach((cleanup) => cleanup());
    };
  }, [
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    appMode,
    createLayerTileLifecycle,
    getInsertBeforeId,
    reconcileLayerOrder,
  ]);

  const displayedAoi = isAoiEditing
    ? null
    : appMode === 'ask' || selectedAOI?.source === 'location_search_preview'
    ? selectedAOI
    : null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    if (appMode !== 'agent') {
      removeBusinessLayerMapLayers(map);
      reconcileLayerOrder(map);
      return;
    }

    const drawFeatureIds = new Set(
      (drawRef.current?.getAll?.().features || [])
        .map((feature) => String(feature?.id || '').trim())
        .filter(Boolean)
    );

    const visibleLayers = (businessLayers || []).filter((layer) => layer?.is_visible !== false);

    const features = visibleLayers
      .filter((layer) => layer?.geojson)
      .filter((layer) => {
        const layerSource = String(layer.source || '').toLowerCase();
        if ((layerSource === 'draw' || layerSource === 'edited') && drawFeatureIds.has(String(layer.id))) {
          return false;
        }
        return true;
      })
      .map((layer) => ({
        ...(layer.geojson?.type === 'Feature'
          ? layer.geojson
          : { type: 'Feature', properties: {}, geometry: layer.geojson }),
        properties: {
          ...(layer.geojson?.properties || {}),
          id: layer.id,
          label: layer.label,
          source: layer.source,
          is_active: Boolean(layer.is_active),
        },
      }));

    removeBusinessLayerMapLayers(map);

    if (!features.length) {
      reconcileLayerOrder(map);
      return;
    }

    map.addSource(BUSINESS_LAYER_SOURCE_ID, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features,
      },
    });

    map.addLayer({
      id: BUSINESS_LAYER_LAYER_IDS[0],
      type: 'fill',
      source: BUSINESS_LAYER_SOURCE_ID,
      paint: {
        'fill-color': 'rgba(0, 0, 0, 0)',
        'fill-opacity': 0,
      },
    });

    map.addLayer({
      id: BUSINESS_LAYER_LAYER_IDS[1],
      type: 'line',
      source: BUSINESS_LAYER_SOURCE_ID,
      paint: {
        'line-color': [
          'case',
          ['boolean', ['get', 'is_active'], false], '#1d4ed8',
          '#0f766e',
        ],
        'line-width': [
          'case',
          ['boolean', ['get', 'is_active'], false], 2.6,
          1.6,
        ],
      },
    });

    reconcileLayerOrder(map);
  }, [
    appMode,
    businessLayers,
    reconcileLayerOrder,
    removeBusinessLayerMapLayers,
  ]);

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

  useEffect(() => {
    if (appMode !== 'agent' || isAoiEditing) {
      return;
    }

    const confirmedAoi = selectedAOI
      || floodAgentState?.confirmed_aoi
      || floodAgentState?.resolved_aoi
      || null;
    const confirmationVersion = floodAgentState?.confirmation_version || 0;

    if (!confirmedAoi?.bounds || !confirmationVersion) {
      return;
    }

    const focusKey = `${confirmationVersion}:${buildBoundsSignature(confirmedAoi.bounds)}`;
    if (focusKey === lastConfirmationFocusRef.current) {
      return;
    }

    lastConfirmationFocusRef.current = focusKey;
    window.requestAnimationFrame(() => {
      fitAoiBounds(confirmedAoi, { force: true, padding: 64, duration: 800 });
    });
  }, [
    appMode,
    fitAoiBounds,
    floodAgentState,
    isAoiEditing,
    selectedAOI,
  ]);

  return (
    <div className="satgpt-map-shell">
      <div
        ref={mapContainerRef}
        id="map"
        className="map"
        style={{ width: '100%', height: '100%' }}
      />

      {pendingSpatialScopeSave ? (
        <div className="satgpt-map-confirm-card">
          <div className="satgpt-map-confirm-title">Save spatial scope?</div>
          <div className="satgpt-map-confirm-text">
            Double-click finished the polygon. Save it to the spatial scope list or discard it.
          </div>
          <div className="satgpt-map-confirm-actions">
            <button
              type="button"
              className="satgpt-map-confirm-btn secondary"
              onClick={handleDiscardPendingSpatialScope}
            >
              Discard
            </button>
            <button
              type="button"
              className="satgpt-map-confirm-btn primary"
              onClick={handleConfirmPendingSpatialScope}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default MapContainer;
