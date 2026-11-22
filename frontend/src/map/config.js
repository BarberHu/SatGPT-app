const runtimeConfig = (typeof globalThis !== 'undefined' && globalThis.__SATGPT_RUNTIME_CONFIG__) || {};
const defaultStyle = runtimeConfig.REACT_APP_MAPBOX_STYLE_URL || import.meta.env.REACT_APP_MAPBOX_STYLE_URL;

export const mapOptions = {
  token: runtimeConfig.REACT_APP_MAPBOX_ACCESS_TOKEN || import.meta.env.REACT_APP_MAPBOX_ACCESS_TOKEN,
  style: defaultStyle,
  basemaps: [
    { id: 'default', label: 'Default', style: defaultStyle },
    { id: 'light', label: 'Light', style: 'mapbox://styles/mapbox/light-v11', hideAdministrativeBoundaries: true },
    {
      id: 'satellite-streets', label: 'Satellite Streets', style: 'mapbox://styles/mapbox/satellite-streets-v12',
      hideAdministrativeBoundaries: true, hideRoads: true,
    },
    { id: 'outdoors', label: 'Outdoors', style: 'mapbox://styles/mapbox/outdoors-v12', hideAdministrativeBoundaries: true },
  ],
};
