import React, { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { useAppContext } from '../context/AppContext';

// Mapbox access token - should be set via environment variable
mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_ACCESS_KEY || '';

const DEFAULT_CENTER = [102.0, 16.5];
const DEFAULT_ZOOM = 5;

// Custom Mapbox style (same as original project)
const MAPBOX_STYLE = 'mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp';

function MapContainer() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  
  const {
    setMapInstance,
    selectedGridCords,
    setSelectedGridCords,
    layerData,
    layerVisibility,
    layerOpacity,
    is3DEnabled,
    isBuildingsEnabled,
    setActiveModal,
    appMode,
    agentImagery,
    agentImageryLoading,
    floodAgentState,
    // Agent control states
    agentSelectedPeriod,
    agentSelectedType,
    agentShowFloodDetection,
    agentShowPopulationLayer,
    agentShowUrbanLayer,
    agentShowLandcoverLayer,
    agentImpactData,
  } = useAppContext();

  // Track if map is initialized
  const mapInitialized = useRef(false);

  // Initialize map
  useEffect(() => {
    // Prevent double initialization in StrictMode
    if (mapInitialized.current || mapRef.current) return;
    mapInitialized.current = true;

    // Clear container if it has children (from previous render)
    if (mapContainerRef.current) {
      mapContainerRef.current.innerHTML = '';
    }

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAPBOX_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    // Add navigation controls
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapRef.current = map;
      setMapInstance(map);
      
      // Load grid layer
      loadGridLayer(map);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        mapInitialized.current = false;
      }
    };
  }, [setMapInstance]);

  // Load grid layer
  const loadGridLayer = (map) => {
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
      const features = map.queryRenderedFeatures(e.point, { layers: ['grid_cell-layer'] });
      if (features.length > 0 && features[0].geometry) {
        const cords = features[0].geometry.coordinates[0];
        
        // Remove previous EE layers before setting new grid
        removePreviousLayers(map);
        
        // Set new grid coordinates (this triggers useMapData to fetch new data)
        setSelectedGridCords(cords);
        drawSelectedPolygon(map, cords);
        
        // Fit bounds to selected grid
        const bounds = cords;
        map.fitBounds(
          [
            [bounds[0][0], bounds[0][1]],
            [bounds[2][0], bounds[2][1]],
          ],
          { padding: 150 }
        );
      }
    });

    // Change cursor on hover
    map.on('mouseenter', 'grid_cell-layer', () => {
      map.getCanvas().style.cursor = 'pointer';
    });

    map.on('mouseleave', 'grid_cell-layer', () => {
      map.getCanvas().style.cursor = '';
    });
  };

  // Remove previous EE layers
  const removePreviousLayers = (map) => {
    const layerIds = ['water-layer', 'flood-layer', 'lclu-layer', 'populationDensity-layer', 'soilTexture-layer', 'healthCareAccess-layer'];
    const sourceIds = ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
    
    layerIds.forEach(id => {
      if (map.getLayer(id)) {
        map.removeLayer(id);
      }
    });
    
    sourceIds.forEach(id => {
      if (map.getSource(id)) {
        map.removeSource(id);
      }
    });
  };

  // Draw selected polygon
  const drawSelectedPolygon = (map, cords) => {
    // Remove existing line if present
    if (map.getLayer('LineString')) {
      map.removeLayer('LineString');
    }
    if (map.getSource('LineString')) {
      map.removeSource('LineString');
    }

    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            properties: {},
            coordinates: cords,
          },
        },
      ],
    };

    map.addSource('LineString', {
      type: 'geojson',
      data: geojson,
    });

    map.addLayer({
      id: 'LineString',
      type: 'line',
      source: 'LineString',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#FFFFFF',
        'line-width': 5,
      },
    });
  };

  // Update EE layers when layer data changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const layers = ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
    
    layers.forEach((layerName) => {
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
  }, [layerData]);

  // Update layer visibility and opacity
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const layers = ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
    
    layers.forEach((layerName) => {
      if (map.getLayer(`${layerName}-layer`)) {
        const opacity = layerVisibility[layerName] ? layerOpacity[layerName] : 0;
        map.setPaintProperty(`${layerName}-layer`, 'raster-opacity', opacity);
      }
    });
  }, [layerVisibility, layerOpacity]);

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

  // ========== FloodAgent Imagery Layer Processing ==========
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;

    // Clean up old agent layers
    const agentLayers = [
      'agent-s2-pre', 'agent-s2-peek', 'agent-s2-after',
      'agent-s1-pre', 'agent-s1-peek', 'agent-s1-after',
      'agent-flood-detection',
      'agent-population', 'agent-urban', 'agent-landcover'
    ];
    const agentSources = [
      'agent-s2-pre', 'agent-s2-peek', 'agent-s2-after',
      'agent-s1-pre', 'agent-s1-peek', 'agent-s1-after',
      'agent-flood-detection',
      'agent-population', 'agent-urban', 'agent-landcover'
    ];

    agentLayers.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    agentSources.forEach(id => {
      if (map.getSource(id)) map.removeSource(id);
    });

    if (!agentImagery) return;

    // Determine which period and type to show based on control state
    const periodKey = agentSelectedPeriod; // 'pre_date', 'peek_date', 'after_date'
    const typeKey = agentSelectedType; // 'sentinel2', 'sentinel1'

    // Debug: Log which imagery is being loaded
    // console.log('🗺️ Loading imagery:', {
    //   periodKey,
    //   typeKey,
    //   tileUrl: agentImagery[periodKey]?.[typeKey]?.tile_url?.substring(0, 80) + '...',
    //   allPeriods: {
    //     pre_date: agentImagery.pre_date?.[typeKey]?.tile_url ? '✅' : '❌',
    //     peek_date: agentImagery.peek_date?.[typeKey]?.tile_url ? '✅' : '❌',
    //     after_date: agentImagery.after_date?.[typeKey]?.tile_url ? '✅' : '❌',
    //   }
    // });

    // Add selected Sentinel imagery layer
    const periodData = agentImagery[periodKey];
    if (periodData?.[typeKey]?.tile_url) {
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
        paint: {
          'raster-opacity': 1,
        },
      });
    }

    // Add flood detection layer if enabled
    if (agentShowFloodDetection && agentImagery.flood_detection?.tile_url) {
      map.addSource('agent-flood-detection', {
        type: 'raster',
        tiles: [agentImagery.flood_detection.tile_url],
        tileSize: 256,
      });
      map.addLayer({
        id: 'agent-flood-detection',
        type: 'raster',
        source: 'agent-flood-detection',
        paint: {
          'raster-opacity': 0.7,
        },
      });
    }

    // Add impact assessment layers if available and enabled
    if (agentImpactData?.layers) {
      if (agentShowPopulationLayer && agentImpactData.layers.population?.tile_url) {
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
      }
      
      if (agentShowUrbanLayer && agentImpactData.layers.urban?.tile_url) {
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
      }
      
      if (agentShowLandcoverLayer && agentImpactData.layers.landcover?.tile_url) {
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
      }
    }

  }, [agentImagery, appMode, agentSelectedPeriod, agentSelectedType, agentShowFloodDetection, agentShowPopulationLayer, agentShowUrbanLayer, agentShowLandcoverLayer, agentImpactData]);

  // FloodAgent GeoJSON 边界处理
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || appMode !== 'agent') return;
    if (!floodAgentState?.geojson) return;

    const sourceId = 'agent-geojson';
    const layerId = 'agent-geojson-layer';
    const outlineLayerId = 'agent-geojson-outline';

    // 移除已存在的图层和源
    if (map.getLayer(outlineLayerId)) map.removeLayer(outlineLayerId);
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // 添加新的源和图层
    map.addSource(sourceId, {
      type: 'geojson',
      data: floodAgentState.geojson,
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

    // 适配边界
    if (floodAgentState.bounds) {
      const { west, south, east, north } = floodAgentState.bounds;
      map.fitBounds([[west, south], [east, north]], { padding: 50 });
    }
  }, [floodAgentState?.geojson, floodAgentState?.bounds, appMode]);

  // Zoom to country
  const zoomToCountry = useCallback((bounds) => {
    const map = mapRef.current;
    if (!map) return;

    map.fitBounds([
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ]);
  }, []);

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
