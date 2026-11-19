import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geometryAreaSquareMeters, formatGeometryArea } from '../../frontend/src/utils/geometryArea.js';
import { regionPresentation } from '../../frontend/src/harness/map/regionPresentation.js';

const triangle = {type:'Polygon',coordinates:[[[0,0],[.01,0],[0,.01],[0,0]]]};
const square = {type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[0,.01],[0,0]]]};

test('display area uses actual polygon, subtracts holes and sums multipolygons', () => {
  const triangleArea = geometryAreaSquareMeters(triangle);
  const squareArea = geometryAreaSquareMeters(square);
  assert.ok(Math.abs(triangleArea / squareArea - .5) < .000001);
  const hole = [[.002,.002],[.008,.002],[.008,.008],[.002,.008],[.002,.002]];
  const withHole = {type:'Polygon',coordinates:[square.coordinates[0],hole]};
  const holeArea = geometryAreaSquareMeters({type:'Polygon',coordinates:[hole]});
  assert.ok(Math.abs(geometryAreaSquareMeters(withHole) - (squareArea-holeArea)) < .001);
  const multi = {type:'MultiPolygon',coordinates:[triangle.coordinates,withHole.coordinates]};
  assert.ok(Math.abs(geometryAreaSquareMeters(multi) - (triangleArea+squareArea-holeArea)) < .001);
  assert.equal(geometryAreaSquareMeters({type:'Point',coordinates:[0,0]}),null);
  assert.equal(geometryAreaSquareMeters(null),null);
  assert.equal(formatGeometryArea(248e6),'248 km²');
  assert.equal(formatGeometryArea(8.131882e6),'8.13 km²');
  assert.equal(formatGeometryArea(1234),'1,234 m²');
  assert.equal(formatGeometryArea(NaN),'');
});

test('display states distinguish incomplete, ready, confirmed and reversible edits', () => {
  assert.equal(regionPresentation({},true).state,'viewport');
  assert.equal(regionPresentation({},false).hint,'Waiting for map');
  assert.equal(regionPresentation({editing:true},true).label,'Drawing polygon…');
  assert.equal(regionPresentation({editing:true,canConfirm:true},true).label,'Confirm area on map');
  assert.equal(regionPresentation({confirmed:triangle,editing:true,canConfirm:true},true).label,'Editing area…');
  assert.equal(regionPresentation({editing:true,error:'Invalid polygon'},true).hint,'Invalid polygon');
  assert.match(regionPresentation({confirmed:triangle},true).label,/^Area 1 · .+ m²$/);
  assert.equal(regionPresentation({confirmed:triangle},true).hint,'');
  assert.equal(regionPresentation({editing:true,canConfirm:true},true).hint,'');
});
