import { getAoiValidationError } from './aoiValidation.js';

/** Spherical area of the actual EPSG:4326 geometry, including holes. */
export function geometryAreaSquareMeters(geometry) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || getAoiValidationError(geometry)) return null;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const radians = n => n * Math.PI / 180;
  let area = 0;
  for (const polygon of polygons) polygon.forEach((ring, index) => {
    const sum = ring.reduce((value, a, i) => {
      const b = ring[(i + 1) % ring.length];
      return value + radians(b[0] - a[0]) * (2 + Math.sin(radians(a[1])) + Math.sin(radians(b[1])));
    }, 0);
    area += Math.abs(sum) * 6371008.8 ** 2 / 2 * (index === 0 ? 1 : -1);
  });
  return Number.isFinite(area) && area > 0 ? area : null;
}

export function formatGeometryArea(area) {
  if (!Number.isFinite(area) || area <= 0) return '';
  const squareKilometers = area >= 1e6;
  const value = squareKilometers ? area / 1e6 : area;
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value)} ${squareKilometers ? 'km²' : 'm²'}`;
}
