import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegionSelection } from '../../frontend/src/harness/map/regionSelection.js';
import { BasicMapPort } from '../../frontend/src/map/BasicMapPort.js';
import { emptyStream, receiveStream } from '../../frontend/src/harness/streamState.js';

const geometry = { type: 'Polygon', coordinates: [[[113.6,34.7],[113.64,34.7],[113.62,34.74],[113.6,34.7]]] };
const feature = { type:'Feature', properties:{}, geometry };
const storage = () => { const entries = new Map(); return { getItem:key => entries.get(key) ?? null, setItem:(key,value) => entries.set(key,value) }; };

test('draw/edit/cancel/clear transactions, explicit confirmation and detached session snapshots', () => {
  const saved = storage(); const a = new RegionSelection('a', saved);
  assert.equal(a.snapshot(), null);
  a.begin(); a.update([feature], false);
  assert.equal(a.confirm(), false);
  assert.throws(() => a.snapshot(), /Finish or cancel/);
  a.update([feature], true);
  assert.equal(a.confirm(), true);
  const submitted = a.snapshot();
  a.begin(); const edited = structuredClone(feature); edited.geometry.coordinates[0][1][0] += .01;
  a.update([edited], true); a.cancel(); assert.deepEqual(a.snapshot(), geometry);
  a.begin(); a.update([edited], true); a.confirm();
  assert.deepEqual(submitted, geometry);
  assert.notDeepEqual(a.snapshot(), geometry);
  assert.equal(new RegionSelection('b', saved).snapshot(), null);
  assert.deepEqual(new RegionSelection('a', saved).snapshot(), edited.geometry);
  a.clear(); assert.equal(a.snapshot(), null);
  assert.equal(new RegionSelection('a', saved, [{role:'user',analysis_region:geometry}]).snapshot(), null);
  assert.deepEqual(new RegionSelection('old', saved, [{role:'user',content:'Legacy bounds only'}]).snapshot(), null);
  assert.deepEqual(new RegionSelection('history', saved, [{role:'user',analysis_region:geometry}]).snapshot(), geometry);
});

test('draw events, IDs, listeners and mode visibility are isolated on one engine', () => {
  const listeners = new Map(), layers = new Map(), sources = new Map();
  const map = {
    isStyleLoaded:() => true, getCanvas:() => ({style:{}}), setTerrain:() => {},
    on:(event, fn) => { const rows = listeners.get(event) || []; rows.push(fn); listeners.set(event, rows); },
    off:(event, fn) => listeners.set(event, (listeners.get(event)||[]).filter(row => row !== fn)),
    fire:(event, data) => (listeners.get(event)||[]).forEach(fn => fn(data)),
    addSource:(id,spec) => sources.set(id,spec), getSource:id => sources.get(id),
    addLayer:spec => layers.set(spec.id,spec), getLayer:id => layers.get(id),
    setLayoutProperty:(id,key,value) => { layers.get(id).layout[key] = value; },
  };
  const basic = new BasicMapPort(map), agent = new BasicMapPort(map, 'satgpt-agent-aoi');
  let basicChanges = 0, agentChanges = 0;
  basic.on('draw.create', () => basicChanges++); agent.on('draw.create', () => agentChanges++);
  basic.activate(true);
  for (const owner of [basic, agent]) {
    owner.addSource('mapbox-gl-draw-cold', {type:'geojson', data:{}});
    owner.addLayer({id:'gl-draw-polygon-fill', source:'mapbox-gl-draw-cold', type:'fill'});
  }
  basic.fire('draw.create', {features:[feature]});
  assert.deepEqual([basicChanges,agentChanges],[1,0]);
  basic.activate(false); agent.activate(true); agent.fire('draw.create', {features:[feature]});
  assert.deepEqual([basicChanges,agentChanges],[1,1]);
  assert.equal(layers.get('satgpt-basic-aux:gl-draw-polygon-fill').layout.visibility, 'none');
  assert.equal(layers.get('satgpt-agent-aoi-aux:gl-draw-polygon-fill').layout.visibility, 'visible');
  agent.activate(false); basic.activate(true);
  assert.equal(layers.get('satgpt-basic-aux:gl-draw-polygon-fill').layout.visibility, 'visible');
  assert.equal(sources.size,2); assert.equal(basic.map, agent.map);
});

test('SSE replay does not duplicate text or settle a scoped task twice', () => {
  let state = receiveStream(emptyStream('job'), {type:'snapshot',task_id:'job',id:4,
    task:{id:'job',status:'running',analysis_region:structuredClone(geometry)},
    answer:{attempt_id:'attempt',text:'',status:'streaming'}});
  const delta = {type:'answer.delta',task_id:'job',id:5,attempt_id:'attempt',text:'Scoped answer'};
  state = receiveStream(state,delta);
  assert.equal(receiveStream(state,delta),state);
  assert.equal(state.answer.text,'Scoped answer');
  const terminal = {type:'task',task_id:'job',id:6,patch:{status:'completed',output:{message:'Scoped answer'}}};
  state = receiveStream(state,terminal);
  assert.equal(receiveStream(state,terminal),state);
  assert.equal(state.answer,null);
  assert.deepEqual(state.task.analysis_region,geometry);
  assert.equal(state.task.output.message,'Scoped answer');
});
