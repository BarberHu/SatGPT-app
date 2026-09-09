export const bindMapEvents = (map, bindings = []) => {
  bindings.forEach(({ event, layerId, handler }) => {
    if (layerId) {
      map.on(event, layerId, handler);
    } else {
      map.on(event, handler);
    }
  });

  return () => {
    bindings.forEach(({ event, layerId, handler }) => {
      if (layerId) {
        map.off(event, layerId, handler);
      } else {
        map.off(event, handler);
      }
    });
  };
};

export const removeMapLayerAndSource = (map, layerId, sourceId = layerId) => {
  const hadLayer = Boolean(map.getLayer(layerId));
  const hadSource = Boolean(map.getSource(sourceId));

  if (hadLayer) {
    map.removeLayer(layerId);
  }
  if (hadSource) {
    map.removeSource(sourceId);
  }

  return hadLayer || hadSource;
};

export const reconcileRasterLayer = (map, {
  layerId,
  sourceId = layerId,
  tileUrl,
  previousTileUrl = null,
  visible = true,
  opacity = 1,
  beforeId = null,
  tileSize = 256,
}) => {
  if (!tileUrl) {
    const removed = removeMapLayerAndSource(map, layerId, sourceId);
    return { sourceChanged: removed, status: removed ? 'removed' : 'absent' };
  }

  let source = map.getSource(sourceId);
  let layer = map.getLayer(layerId);
  let sourceChanged = !source || previousTileUrl !== tileUrl;

  if (source && previousTileUrl !== tileUrl) {
    if (typeof source.setTiles === 'function') {
      source.setTiles([tileUrl]);
    } else {
      removeMapLayerAndSource(map, layerId, sourceId);
      source = null;
      layer = null;
    }
  }

  if (!source) {
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [tileUrl],
      tileSize,
    });
    source = map.getSource(sourceId);
    sourceChanged = true;
  }

  if (!layer) {
    const definition = {
      id: layerId,
      type: 'raster',
      source: sourceId,
      layout: {
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'raster-opacity': opacity,
      },
    };
    if (beforeId && map.getLayer(beforeId)) {
      map.addLayer(definition, beforeId);
    } else {
      map.addLayer(definition);
    }
    return { sourceChanged, status: 'created' };
  }

  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  map.setPaintProperty(layerId, 'raster-opacity', opacity);
  return { sourceChanged, status: sourceChanged ? 'updated' : 'reused' };
};
