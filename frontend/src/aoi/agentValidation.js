import { getAoiValidationError } from '../utils/aoiValidation.js';
import { geometryAreaSquareMeters } from '../utils/geometryArea.js';

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const intersects = (a, b, c, d) => !(Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
  || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1]))
  && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
const edges = ring => ring.slice(1).map((b, i) => [ring[i], b]);
const ringsCross = (a, b) => edges(a).some(x => edges(b).some(y => intersects(...x, ...y)));
const inside = (p, ring) => {
  let result = false;
  for (const [a, b] of edges(ring)) if ((a[1] > p[1]) !== (b[1] > p[1])
    && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  return result;
};

/** Target-specific limits; saving a larger valid area never truncates its geometry. */
export function agentRegionError(geometry) {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return 'Choose a Polygon or MultiPolygon analysis area.';
  const basic = getAoiValidationError(geometry);
  if (basic) return basic;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  if (polygons.length > 32 || polygons.some(p => p.length > 64)) return 'Agent analysis supports at most 32 polygons and 64 rings per polygon.';
  const points = polygons.flat(2);
  if (points.length > 2048) return 'Agent analysis supports at most 2048 vertices. The saved area has been kept unchanged.';
  if (Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])) > 180) return 'Areas crossing the antimeridian are not supported.';
  const area = geometryAreaSquareMeters(geometry);
  if (area == null || area < 1 || area > 5e12) return 'Choose an area between 1 m² and 5 million km².';
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) return 'Polygon rings must be closed.';
      const segments = edges(ring);
      if (segments.some(([a, b]) => a[0] === b[0] && a[1] === b[1]) || segments.some((x, i) => segments.some((y, j) =>
        j > i + 1 && !(i === 0 && j === segments.length - 1) && intersects(...x, ...y)))) return 'Polygon rings must not self-intersect or repeat vertices.';
    }
    for (let i = 1; i < polygon.length; i++) {
      const hole = polygon[i];
      if (!inside(hole[0], polygon[0]) || polygon.slice(0, i).some(r => ringsCross(hole, r))
        || polygon.slice(1, i).some(r => inside(hole[0], r) || inside(r[0], hole))) return 'Holes must be inside the exterior and must not overlap or intersect.';
    }
  }
  for (let i = 0; i < polygons.length; i++) for (const other of polygons.slice(0, i)) {
    const polygon = polygons[i];
    if (polygon.some(a => other.some(b => ringsCross(a, b)))
      || (inside(polygon[0][0], other[0]) && !other.slice(1).some(h => inside(polygon[0][0], h)))
      || (inside(other[0][0], polygon[0]) && !polygon.slice(1).some(h => inside(other[0][0], h)))) return 'MultiPolygon components must not overlap or intersect.';
  }
  return '';
}
