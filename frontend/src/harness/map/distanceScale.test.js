import { distanceScale } from '../../map/distanceScale';

test('multi-tick ruler uses round metric values like 0 / 25 / 50 / 100 km', () => {
  const scale = distanceScale(width => width * 600, 192);
  expect(scale.meters).toBe(100000);
  expect(scale.unit).toBe('km');
  expect(scale.ticks.map(t => t.label)).toEqual(['0', '25', '50', '100']);
  expect(scale.width).toBeCloseTo(100000 / 600, 1);
});

test('ruler responds to zoom, uses meters for close views, and solves non-linear projection widths', () => {
  const near = distanceScale(width => width, 192);
  expect(near.unit).toBe('m');
  expect(near.meters).toBe(100);
  expect(near.width).toBeCloseTo(100, 1);
  const perspective = distanceScale(width => width * width, 200);
  expect(perspective.meters).toBe(20000);
  expect(perspective.width).toBeCloseTo(Math.sqrt(20000), 1);
});

test('unavailable projections and too-small panels do not display a fabricated scale', () => {
  expect(distanceScale(() => NaN, 192)).toBeNull();
  expect(distanceScale(() => 0, 192)).toBeNull();
  expect(distanceScale(() => undefined, 192)).toBeNull();
  expect(distanceScale(() => 1000, 20)).toBeNull();
});
