import { buildAoiFromGeoJSON } from './aoi';
import { getAoiValidationError } from './aoiValidation';

const ring = [[118, 32], [119, 32], [119, 33], [118, 33], [118, 32]];
const polygon = (coordinates = [ring]) => ({ type: 'Polygon', coordinates });

describe('AOI geometry validation', () => {
  test.each([
    [[[118, 32]]],
    [[[118, 32], [118, 32], [118, 32], [118, 32]]],
    [[[118, 32], [119, 33], [120, 34], [118, 32]]],
    [[[null, null], [119, 32], [119, 33], [null, null]]],
    [[[13200000, 3750000], [13201000, 3750000], [13201000, 3751000], [13200000, 3750000]]],
    [ring, [[118.2, 32.2]]],
  ].map((coordinates) => ({ coordinates })))('rejects invalid rings without normalizing them into a different scope: %j', ({ coordinates }) => {
    const input = polygon(coordinates);
    expect(getAoiValidationError(input)).toBeTruthy();
    expect(buildAoiFromGeoJSON(input)).toBeNull();
  });

  test('accepts a polygon with a hole and a valid MultiPolygon', () => {
    expect(buildAoiFromGeoJSON(polygon([ring, [[118.2, 32.2], [118.4, 32.2], [118.4, 32.4], [118.2, 32.2]]]))).not.toBeNull();
    expect(buildAoiFromGeoJSON({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).not.toBeNull();
  });

  test('rejects an entire MultiPolygon if one polygon is invalid', () => {
    expect(buildAoiFromGeoJSON({ type: 'MultiPolygon', coordinates: [[ring], [[[118, 32]]]] })).toBeNull();
  });

  test('rejects projected CRS even if its numbers happen to look like degrees', () => {
    expect(getAoiValidationError({ ...polygon(), crs: { properties: { name: 'EPSG:3857' } } })).toContain('Reproject');
    expect(getAoiValidationError({ ...polygon(), crs: { properties: { name: 'EPSG:4326' } } })).toBeNull();
  });
});
