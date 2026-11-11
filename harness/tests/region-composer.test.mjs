import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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

const require = createRequire(new URL('../../frontend/package.json',import.meta.url));
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
previousNodeEnv === undefined ? delete process.env.NODE_ENV : process.env.NODE_ENV = previousNodeEnv;
const {buildSync} = require('esbuild');
const frontend = fileURLToPath(new URL('../../frontend',import.meta.url));
const compiled = buildSync({entryPoints:[`${frontend}/src/harness/components/Composer.jsx`],bundle:true,
  platform:'node',format:'cjs',write:false,external:['react'],alias:{'@':`${frontend}/src`},
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const module = {exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(require,module,module.exports);
const Composer = module.exports.default;
const render = (region,extra={}) => renderToStaticMarkup(React.createElement(Composer,{
  value:'Compare surface water before and after the flood.',onChange:()=>{},onSend:()=>{},onEditRegion:()=>{},
  mapReady:true,region:{ready:true,cancel:()=>{},clear:()=>{},...region},...extra,
}));

test('composer places a single compact area group below input with accessible icon actions', () => {
  const html = render({confirmed:triangle});
  assert.ok(html.indexOf('</textarea>') < html.indexOf('agent-region-chip'));
  assert.equal((html.match(/role="group"/g)||[]).length,1);
  assert.match(html,/aria-label="Edit analysis area"/);
  assert.match(html,/aria-label="Clear analysis area"/);
  assert.ok(!html.includes('>Clear</'));
  assert.match(html,/Area 1 ·/);
  assert.ok(!html.includes('agent-region-hint'));
  const viewport = render({});
  assert.match(viewport,/Current map view/);
  assert.ok(!viewport.includes('agent-region-chip'));
  const drawing = render({editing:true});
  assert.match(drawing,/Drawing polygon…/);
  assert.match(drawing,/aria-label="Cancel area editing"/);
  assert.match(drawing,/<button[^>]*type="submit"[^>]*disabled=""/);
  assert.ok(!drawing.includes('aria-label="Edit analysis area"'));
  const ready = render({editing:true,canConfirm:true});
  assert.match(ready,/Confirm area on map/);
  assert.ok(!ready.includes('agent-region-hint'));
  assert.match(render({confirmed:triangle},{busy:true,onStop:()=>{}}),/aria-label="Stop response"/);
});
