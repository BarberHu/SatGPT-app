const LAYER_RESPONSE_FIELDS = [
  ['singleInundationEvent', 'SingleInundationEvent', 'singleInundationEventMeta'],
  ['inundationHotspot', 'InundationHotspot', 'inundationHotspotMeta'],
  ['wildfireRisk', 'WildfireRisk', 'wildfireRiskMeta'],
  ['landslideRisk', 'LandslideRisk', 'landslideRiskMeta'],
  ['activeFireDetections', 'ActiveFireDetections', 'activeFireDetectionsMeta'],
  ['burnHistory', 'BurnHistory', 'burnHistoryMeta'],
  ['slopeSteepness', 'SlopeSteepness', 'slopeSteepnessMeta'],
  ['water', 'Water'],
  ['flood', 'Flood'],
  ['lclu', 'LCLU'],
  ['populationDensity', 'PopulationDensity'],
  ['soilTexture', 'SoilTexture'],
  ['healthCareAccess', 'HealthCareAccess'],
];

export const createEmptyLayerData = () => Object.fromEntries(
  LAYER_RESPONSE_FIELDS.map(([key]) => [key, null])
);

export const normalizeLayerData = (data = {}, options = {}) => {
  const { partial = false, aoiSignature = null, requestKey = null } = options;

  return LAYER_RESPONSE_FIELDS.reduce((normalized, [key, responseName, metaField]) => {
    const urlField = `eeMapURL${responseName}`;
    if (partial && !Object.prototype.hasOwnProperty.call(data, urlField)) {
      return normalized;
    }

    normalized[key] = data[urlField]
      ? {
          mapId: data[`eeMapId${responseName}`],
          token: data[`eeToken${responseName}`],
          tileUrl: data[urlField],
          ...(metaField ? { meta: data[metaField] || null } : {}),
          aoiSignature,
          requestKey,
        }
      : null;
    return normalized;
  }, {});
};
