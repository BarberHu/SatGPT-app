const DEFAULT_COLOR = '#0ea5e9';

const PRODUCT_GROUP_LABELS = {
  flood_event_classification: 'Flood Classification',
  flood_event_archive: 'Flood Archive',
  surface_water_history: 'Surface Water History',
  surface_water_frequency: 'Surface Water Frequency',
  basin_context: 'Basin Context',
  river_context: 'River Context',
};

const PRODUCT_GROUP_ORDER = {
  flood_event_classification: 10,
  flood_event_archive: 20,
  surface_water_history: 30,
  surface_water_frequency: 40,
  basin_context: 50,
  river_context: 60,
};

const clampOpacity = (value, fallback) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
};

export const normalizeCatalogColor = (value) => {
  if (!value || typeof value !== 'string') {
    return DEFAULT_COLOR;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_COLOR;
  }

  if (trimmed.startsWith('#') || /^[a-z]+$/i.test(trimmed)) {
    return trimmed;
  }

  if (/^[0-9a-f]{3,8}$/i.test(trimmed)) {
    return `#${trimmed}`;
  }

  return trimmed;
};

const getRuntimeUiProfile = (descriptor) => (
  descriptor?.ui_profile
  || descriptor?.source_meta?.ui_profile
  || {}
);

const getLegendSpec = (descriptor) => (
  descriptor?.source_meta?.legend_spec
  || descriptor?.legend_spec
  || null
);

export const getCatalogGroupLabel = (productGroup) => (
  PRODUCT_GROUP_LABELS[productGroup] || 'Other Context'
);

export const getCatalogGroupOrder = (productGroup) => (
  PRODUCT_GROUP_ORDER[productGroup] || 999
);

export const sortCatalogLayers = (layers = []) => (
  [...layers].sort((left, right) => {
    const leftGroupOrder = getCatalogGroupOrder(left.product_group);
    const rightGroupOrder = getCatalogGroupOrder(right.product_group);
    if (leftGroupOrder !== rightGroupOrder) {
      return leftGroupOrder - rightGroupOrder;
    }

    const leftOrder = Number(left.ui_profile?.order ?? left.selection_profile?.priority ?? 0);
    const rightOrder = Number(right.ui_profile?.order ?? right.selection_profile?.priority ?? 0);
    if (leftOrder !== rightOrder) {
      return rightOrder - leftOrder;
    }

    return String(left.title || '').localeCompare(String(right.title || ''));
  })
);

export const buildCatalogLegendModel = (descriptor, fallbackTitle) => {
  if (!descriptor) {
    return null;
  }

  const legend = descriptor.legend || {};
  const visRecipe = descriptor.vis_recipe || {};
  const legendSpec = getLegendSpec(descriptor);
  const fallbackLabel = legend.label || descriptor.source_meta?.title || fallbackTitle || 'Recommended layer';

  if (legendSpec?.type === 'categorical' && Array.isArray(legendSpec.items)) {
    return {
      type: 'classes',
      label: legendSpec.label || fallbackLabel,
      items: legendSpec.items.map((item) => ({
        ...item,
        color: normalizeCatalogColor(item.color),
      })),
    };
  }

  if (legendSpec?.type === 'continuous' && Array.isArray(legendSpec.palette) && legendSpec.palette.length) {
    return {
      type: 'palette',
      label: legendSpec.label || fallbackLabel,
      palette: legendSpec.palette.map(normalizeCatalogColor),
      min: legendSpec.min,
      max: legendSpec.max,
    };
  }

  if (legendSpec?.type === 'vector' && legendSpec.style) {
    return {
      type: 'solid',
      label: legendSpec.label || fallbackLabel,
      color: normalizeCatalogColor(legendSpec.style.color || legendSpec.style.fillColor),
    };
  }

  if (legendSpec?.type === 'text') {
    return {
      type: 'text',
      label: legendSpec.label || fallbackLabel,
    };
  }

  if (Array.isArray(legend.palette) && legend.palette.length) {
    return {
      type: 'palette',
      label: fallbackLabel,
      palette: legend.palette.map(normalizeCatalogColor),
      min: legend.min,
      max: legend.max,
    };
  }

  const solidColor =
    visRecipe?.style?.color
    || visRecipe?.style?.fillColor
    || (Array.isArray(visRecipe?.palette) && visRecipe.palette[visRecipe.palette.length - 1])
    || DEFAULT_COLOR;

  return {
    type: 'solid',
    label: fallbackLabel,
    color: normalizeCatalogColor(solidColor),
  };
};

export const buildVisibleCatalogLegendEntries = ({ layers = [], runtimeData = {}, visibility = {} }) => (
  sortCatalogLayers(layers)
    .filter((layer) => visibility[layer.id])
    .map((layer) => {
      const descriptor = runtimeData?.[layer.id] || null;
      return {
        id: layer.id,
        title: layer.title,
        descriptor,
        legendModel: buildCatalogLegendModel(descriptor, layer.title),
      };
    })
    .filter((entry) => entry.descriptor?.tile_url && entry.legendModel)
);

export const getCatalogLayerStatus = ({ layer, descriptor, visible, loading }) => {
  if (loading) {
    return { tone: 'loading', label: 'Loading' };
  }

  if (visible && descriptor?.tile_url) {
    return { tone: 'ready', label: 'Tile ready' };
  }

  if (visible) {
    return { tone: 'pending', label: 'Pending' };
  }

  const defaultVisible = Boolean(layer?.ui_profile?.default_visible);
  return { tone: defaultVisible ? 'idle' : 'off', label: defaultVisible ? 'Not loaded' : 'Optional' };
};

export const buildCatalogPanelEntries = ({ layers = [], runtimeData = {}, visibility = {}, loading = {} }) => {
  const grouped = new Map();

  sortCatalogLayers(layers).forEach((layer) => {
    const descriptor = runtimeData?.[layer.id] || null;
    const legendModel = buildCatalogLegendModel(descriptor, layer.title);
    const visible = Boolean(visibility?.[layer.id]);
    const groupKey = layer.ui_profile?.group || layer.product_group || 'other';

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        key: groupKey,
        label: layer.ui_profile?.group_label || getCatalogGroupLabel(groupKey),
        order: getCatalogGroupOrder(groupKey),
        items: [],
      });
    }

    grouped.get(groupKey).items.push({
      layer,
      descriptor,
      legendModel,
      visible,
      loading: Boolean(loading?.[layer.id]),
      status: getCatalogLayerStatus({
        layer,
        descriptor,
        visible,
        loading: Boolean(loading?.[layer.id]),
      }),
    });
  });

  return [...grouped.values()].sort((left, right) => left.order - right.order);
};

export const getCatalogMapLayerId = (layerId) => `agent-rec-${String(layerId || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export const isCatalogMapLayerId = (id) => String(id || '').startsWith('agent-rec-');

export const getCatalogDefaultOpacity = (descriptor) => {
  const uiProfile = getRuntimeUiProfile(descriptor);
  const fallback = getLegendSpec(descriptor)?.type === 'vector' ? 0.9 : 0.82;
  return clampOpacity(uiProfile.default_opacity, fallback);
};

export const buildCatalogMapLayerDefinition = (layerId, descriptor) => {
  if (!descriptor?.tile_url) {
    return null;
  }

  const mapLayerId = getCatalogMapLayerId(layerId);
  return {
    mapLayerId,
    source: {
      type: 'raster',
      tiles: [descriptor.tile_url],
      tileSize: 256,
    },
    layer: {
      id: mapLayerId,
      type: 'raster',
      source: mapLayerId,
      paint: {
        'raster-opacity': getCatalogDefaultOpacity(descriptor),
      },
    },
  };
};
