const invalidRing = (ring) => {
  if (!Array.isArray(ring) || ring.length < 3) return 'A polygon ring needs at least three distinct vertices.';
  if (ring.some((point) => !Array.isArray(point) || point.length < 2
    || !point.slice(0, 2).every((value) => typeof value === 'number' && Number.isFinite(value)))) {
    return 'AOI coordinates must be finite numbers; null and text coordinates are not supported.';
  }
  if (ring.some(([lng, lat]) => lng < -180 || lng > 180 || lat < -90 || lat > 90)) {
    return 'AOI coordinates must be longitude/latitude in EPSG:4326. Reproject meter-based coordinates before uploading.';
  }
  if (new Set(ring.map(([lng, lat]) => `${lng},${lat}`)).size < 3) {
    return 'A polygon ring needs at least three distinct vertices.';
  }
  // Translate to the first vertex to avoid cancellation for small local scopes.
  const [x0, y0] = ring[0];
  const twiceArea = ring.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = ring[(index + 1) % ring.length];
    return sum + (x - x0) * (nextY - y0) - (nextX - x0) * (y - y0);
  }, 0);
  return twiceArea === 0 ? 'A polygon ring must enclose a non-zero area.' : null;
};

export function getAoiValidationError(input) {
  let polygonCount = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return 'The file contains an invalid GeoJSON object.';
    if (node.crs) {
      const name = node.crs.properties?.name || '';
      if (!/(?:^|:)4326$|CRS84$/i.test(name)) {
        return 'Only longitude/latitude GeoJSON (EPSG:4326 / CRS84) is supported. Reproject the file before uploading.';
      }
    }
    if (node.type === 'Feature') return visit(node.geometry);
    if (node.type === 'FeatureCollection' || node.type === 'GeometryCollection') {
      const children = node.type === 'FeatureCollection' ? node.features : node.geometries;
      if (!Array.isArray(children)) return 'The GeoJSON collection must contain an array.';
      for (const child of children) {
        const error = visit(child);
        if (error) return error;
      }
      return null;
    }
    if (node.type === 'Polygon' || node.type === 'MultiPolygon') {
      const polygons = node.type === 'Polygon' ? [node.coordinates] : node.coordinates;
      if (!Array.isArray(polygons) || !polygons.length) return 'The file contains an empty polygon.';
      for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) return 'A polygon needs an exterior ring.';
        for (const ring of polygon) {
          const error = invalidRing(ring);
          if (error) return error;
        }
        polygonCount += 1;
      }
    }
    return null;
  };
  const error = visit(input);
  return error || (polygonCount ? null : 'The file does not contain a valid Polygon or MultiPolygon scope.');
}
