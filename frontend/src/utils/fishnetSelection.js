export const FISHNET_DATA_URL = '/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson';

export const indexFishnetFeatures = (geojson) => new Map(
  geojson.features
    .filter((feature) => feature.properties?.FID != null && feature.geometry?.type === 'Polygon')
    .map((feature) => [String(feature.properties.FID), feature])
);

let fishnetDataPromise;

// Share the original data between rendering and selection, including StrictMode
// setup replay. A failed load must remain retryable on the next setup.
export const loadFishnetData = () => {
  if (!fishnetDataPromise) {
    fishnetDataPromise = fetch(FISHNET_DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load map grid (${response.status}).`);
        return response.json();
      })
      .then((geojson) => ({ geojson, featuresByFid: indexFishnetFeatures(geojson) }))
      .catch((error) => {
        fishnetDataPromise = undefined;
        throw error;
      });
  }
  return fishnetDataPromise;
};

export const getOriginalFishnetRing = (renderedFeature, featuresByFid) => {
  const fid = renderedFeature?.properties?.FID;
  if (fid == null) return null;
  // Rendered geometry is tile-clipped and quantized. Never use it as an AOI,
  // even when the original feature cannot be found.
  const ring = featuresByFid.get(String(fid))?.geometry.coordinates[0];
  return ring ? ring.map((point) => [...point]) : null;
};
