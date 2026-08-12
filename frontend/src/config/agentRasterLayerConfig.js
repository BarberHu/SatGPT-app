export const AGENT_BASE_LAYER_ORDER_IDS = [
  'agent-s2-pre',
  'agent-s1-pre',
  'agent-s2-peek',
  'agent-s1-peek',
  'agent-s2-after',
  'agent-s1-after',
];

export const AGENT_RASTER_LAYER_KEYS_BY_MODULE = {
  flood: [
    'singleInundationEvent',
    'inundationHotspot',
  ],
  wildfire: [
    'wildfireRisk',
    'burnHistory',
  ],
  landslide: [
    'landslideRisk',
    'slopeSteepness',
  ],
  context: [
    'populationDensity',
    'soilTexture',
    'lclu',
  ],
  imagery: [],
  vector: [],
};

const DEPRECATED_AGENT_RASTER_LAYER_KEYS = [
  'populationExposure',
  'fuelLandCover',
];

const RISK_LEVEL_ITEMS = [
  { value: '1 Low', color: '#2E7D32' },
  { value: '2 Moderate', color: '#FDD835' },
  { value: '3 Watch', color: '#FF8F00' },
  { value: '4 Warning', color: '#E53935' },
  { value: '5 Very high', color: '#B71C1C' },
];

export const CONTEXT_RASTER_LAYER_CONFIG = [
  {
    key: 'populationDensity',
    orderId: 'agent-raster-populationDensity',
    title: 'Population Density',
    infoText: 'CIESIN GPWv4.11 population density clipped to the selected AOI for exposure context.',
    subtitle: 'Population exposure context',
    detailText: 'People per square kilometer',
    dataset: 'CIESIN/GPWv411/GPW_Population_Density',
    legend: {
      type: 'palette',
      label: 'Population density',
      min: '0',
      max: '1000',
      palette: ['#ffffe7', '#ffac1d', '#f2552c', '#9f0c21'],
    },
  },
  {
    key: 'soilTexture',
    orderId: 'agent-raster-soilTexture',
    title: 'Soil Texture',
    infoText: 'OpenLandMap soil texture classes clipped to the selected AOI for infiltration and runoff context.',
    subtitle: 'Soil class context',
    detailText: 'USDA texture classes',
    dataset: 'OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02',
    legend: {
      type: 'classes',
      label: 'Soil texture classes',
      items: [
        { value: 'Cl', color: '#d5c36b' },
        { value: 'SiCl', color: '#b96947' },
        { value: 'SaCl', color: '#9d3706' },
        { value: 'ClLo', color: '#ae868f' },
        { value: 'SiClLo', color: '#f86714' },
        { value: 'SaClLo', color: '#46d143' },
        { value: 'Lo', color: '#368f20' },
        { value: 'SiLo', color: '#3e5a14' },
        { value: 'SaLo', color: '#ffd557' },
        { value: 'Si', color: '#fff72e' },
        { value: 'LoSa', color: '#ff5a9d' },
        { value: 'Sa', color: '#ff005b' },
      ],
    },
  },
  {
    key: 'lclu',
    orderId: 'agent-raster-lclu',
    title: 'LCLU',
    infoText: 'ESA WorldCover land-cover classification clipped to the selected AOI.',
    subtitle: 'Land-cover context',
    detailText: 'ESA WorldCover 2021',
    dataset: 'ESA/WorldCover/v200',
    legend: {
      type: 'classes',
      label: 'ESA WorldCover',
      items: [
        { value: 'Tree', color: '#006400' },
        { value: 'Shrub', color: '#ffbb22' },
        { value: 'Grass', color: '#ffff4c' },
        { value: 'Crop', color: '#f096ff' },
        { value: 'Built', color: '#fa0000' },
        { value: 'Water', color: '#0064c8' },
      ],
    },
  },
];

export const WILDFIRE_RASTER_LAYER_CONFIG = [
  {
    key: 'wildfireRisk',
    orderId: 'agent-raster-wildfireRisk',
    title: 'Wildfire Risk',
    infoText: 'Composite wildfire risk from vegetation dryness, water deficit, temperature anomaly, precipitation deficit, terrain, and forest mask.',
    subtitle: 'Composite 1-5 risk classification',
    detailText: 'Sentinel-2, MODIS LST, CHIRPS, SRTM',
    dataset: 'Multi-source GEE risk model',
    legend: {
      type: 'classes',
      label: 'Wildfire risk level',
      items: RISK_LEVEL_ITEMS,
    },
    hasRecentWindowControl: true,
    recentWindowLabel: 'Risk window',
    defaultRecentWindow: 60,
    minRecentWindow: 7,
    maxRecentWindow: 365,
    recentWindowTicks: [7, 30, 60, 180, 365],
    recentWindowHelpText: 'Risk uses the selected recent window ending today; the baseline is computed from the preceding 3 years.',
  },
  {
    key: 'burnHistory',
    orderId: 'agent-raster-burnHistory',
    title: 'Burn History',
    infoText: 'MODIS burned-area evidence for areas burned within the selected recent window.',
    subtitle: 'Recent burned-area context',
    detailText: 'MODIS MCD64A1 BurnDate',
    dataset: 'MODIS/061/MCD64A1',
    legend: {
      type: 'solid',
      label: 'Burned area',
      color: '#111827',
    },
    hasRecentWindowControl: true,
    recentWindowLabel: 'Burn history window',
    defaultRecentWindow: 365,
    minRecentWindow: 30,
    maxRecentWindow: 1095,
    recentWindowTicks: [30, 180, 365, 730, 1095],
    recentWindowHelpText: 'Burn history shows pixels detected as burned inside the selected recent window ending today.',
    emptyVisibleStatus: 'Visible; blank map means no burned pixels in this window',
  },
];

const LANDSLIDE_RISK_LEVEL_ITEMS = [
  { value: '1 Low', color: '#1565C0' },
  { value: '2 Moderate', color: '#42A5F5' },
  { value: '3 Watch', color: '#FFC107' },
  { value: '4 Warning', color: '#FF6F00' },
  { value: '5 Very high', color: '#D84315' },
];

export const LANDSLIDE_RASTER_LAYER_CONFIG = [
  {
    key: 'landslideRisk',
    orderId: 'agent-raster-landslideRisk',
    title: 'Landslide Risk',
    infoText: 'Composite landslide risk from recent rainfall trigger, slope hazard, SAR-derived soil saturation, vegetation instability, and terrain roughness.',
    subtitle: 'Composite 1-5 risk classification',
    detailText: 'CHIRPS, SRTM, Sentinel-1, Sentinel-2',
    dataset: 'Multi-source GEE risk model',
    legend: {
      type: 'classes',
      label: 'Landslide risk level',
      items: LANDSLIDE_RISK_LEVEL_ITEMS,
    },
    hasRecentWindowControl: true,
    recentWindowLabel: 'Risk window',
    defaultRecentWindow: 60,
    minRecentWindow: 7,
    maxRecentWindow: 365,
    recentWindowTicks: [7, 30, 60, 180, 365],
    recentWindowHelpText: 'Risk uses the selected recent window ending today; rainfall, SAR, and vegetation signals are compared with the preceding 3-year baseline.',
  },
  {
    key: 'slopeSteepness',
    orderId: 'agent-raster-slopeSteepness',
    title: 'Slope Steepness',
    infoText: 'Slope derived from NASA SRTM 30m elevation data. Steeper terrain is a core landslide susceptibility factor.',
    subtitle: 'SRTM-derived terrain slope',
    detailText: 'Slope angle',
    dataset: 'USGS/SRTMGL1_003',
    legend: {
      type: 'palette',
      label: 'Slope steepness',
      min: '0 deg',
      max: '60 deg',
      palette: ['#f7fcf5', '#c7e9c0', '#74c476', '#fd8d3c', '#bd0026'],
    },
  },
];

export const WILDFIRE_PENDING_RASTER_LAYER_CONFIG = [
  {
    key: 'burnSeverity',
    orderId: 'wildfire-raster-burn-severity',
    title: 'Burn Severity',
    infoText: 'NBR and dNBR burn-severity mapping needs explicit pre-fire and post-fire windows before it can be safely rendered.',
    subtitle: 'NBR / dNBR raster classification',
    detailText: 'Service pending',
    unsupportedReason: 'Requires a dedicated pre/post fire date contract.',
    legend: {
      type: 'classes',
      label: 'dNBR severity',
      items: [
        { value: 'Unburned', color: '#4d908e' },
        { value: 'Low', color: '#f9c74f' },
        { value: 'Moderate', color: '#f3722c' },
        { value: 'Severe', color: '#7f1d1d' },
      ],
    },
  },
  {
    key: 'fireWeatherIndex',
    orderId: 'wildfire-raster-fire-weather-index',
    title: 'Fire Weather Index',
    infoText: 'Composite weather risk needs a dedicated meteorological recipe before production rendering.',
    subtitle: 'Wind, humidity, temperature, fuel dryness',
    detailText: 'Service pending',
    unsupportedReason: 'Requires a dedicated fire-weather model endpoint.',
    legend: {
      type: 'palette',
      label: 'Fire weather risk',
      min: 'Low',
      max: 'Extreme',
      palette: ['#38bdf8', '#facc15', '#f97316', '#b91c1c'],
    },
  },
];

export const ALL_AGENT_RASTER_LAYER_NAMES = Array.from(
  new Set([
    ...Object.values(AGENT_RASTER_LAYER_KEYS_BY_MODULE).flat(),
    ...DEPRECATED_AGENT_RASTER_LAYER_KEYS,
  ])
);

export const ALL_AGENT_RASTER_LAYER_IDS = ALL_AGENT_RASTER_LAYER_NAMES.map(
  (layerName) => `agent-raster-${layerName}`
);

export const getAgentRasterLayerNames = (moduleId = 'flood') => (
  AGENT_RASTER_LAYER_KEYS_BY_MODULE[moduleId] || AGENT_RASTER_LAYER_KEYS_BY_MODULE.flood
);

export const getAgentRasterLayerIds = (moduleId = 'flood') => (
  getAgentRasterLayerNames(moduleId).map((layerName) => `agent-raster-${layerName}`)
);

export const buildDefaultAgentRasterLayerVisibility = () => (
  ALL_AGENT_RASTER_LAYER_NAMES.reduce((visibility, layerName) => ({
    ...visibility,
    [layerName]: false,
  }), {})
);

export const buildDefaultAgentLayerOrder = () => [
  ...AGENT_BASE_LAYER_ORDER_IDS,
  ...ALL_AGENT_RASTER_LAYER_IDS,
];
