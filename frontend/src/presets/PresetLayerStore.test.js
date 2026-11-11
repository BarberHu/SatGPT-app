import { test, expect, vi } from 'vitest';
import { PresetLayerStore, PRESET_STORAGE_KEY, presetRequestKey } from './PresetLayerStore';
import { buildAoiFromBounds } from '../utils/aoi';
import { normalizeLayer } from '../map/layerSpec';
import { MapService } from '../map/mapService';

const aoi = (west = 100) => buildAoiFromBounds({ west, south: 10, east: west + .1, north: 10.1 });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; });return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
const setup = (limit = 2) => {
  const jobs=[]; const storage={getItem:vi.fn(()=>null),setItem:vi.fn()};
  const request=vi.fn(row=>{ const job=deferred();jobs.push({...job,row});return job.promise; });
  const store=new PresetLayerStore(request,storage,limit);return {store,request,jobs,storage};
};
test('deduplicates geometry and effective parameters independent of AOI identity', async()=>{
  const {store,request}=setup();
  const first=store.add('singleInundationEvent',aoi(),{year_start:2020,year_end:2021});
  expect(store.add('singleInundationEvent',aoi(),{year_end:'2021',year_start:'2020'})).toBe(first);
  await flush();expect(request).toHaveBeenCalledTimes(1);
  expect(()=>store.add('singleInundationEvent',aoi(),{year_start:2022,year_end:2022})).toThrow();
});
test('limits independent concurrent jobs and isolates failures, empty results and retry',async()=>{
  const {store,jobs,request}=setup();
  const first=store.add('slopeSteepness',aoi(),{});
  const second=store.add('soilTexture',aoi(),{});
  store.add('lclu',aoi(),{});await flush();expect(request).toHaveBeenCalledTimes(2);
  jobs[0].resolve({status:'ready',layer:{url:'saved'}});jobs[1].reject(Error('offline'));await flush();
  expect(request).toHaveBeenCalledTimes(3);
  expect(store.rows.find(row=>row.id===first).status).toBe('ready');
  expect(store.rows.find(row=>row.id===second).status).toBe('error');
  jobs[2].resolve({status:'empty',layer:null});await flush();
  expect(store.rows[0].status).toBe('empty');store.retry(second);await flush();
  jobs[3].resolve({status:'ready',layer:{url:'retried'}});await flush();
  expect(store.rows.find(row=>row.id===second).layer.url).toBe('retried');
});
test('late responses cannot overwrite an updated region/parameter selection or resurrect removal',async()=>{
  const {store,jobs}=setup();
  const id=store.add('singleInundationEvent',aoi(),{year_start:2020,year_end:2020});await flush();
  store.add('singleInundationEvent',aoi(101),{year_start:2021,year_end:2021},id);await flush();
  jobs[1].resolve({status:'ready',layer:{url:'new-region'}});await flush();
  jobs[0].resolve({status:'ready',layer:{url:'old-region'}});await flush();
  expect(store.rows[0].layer.url).toBe('new-region');
  store.retry(id);await flush();store.remove(id);jobs[2].resolve({status:'ready',layer:{url:'removed'}});await flush();
  expect(store.rows).toEqual([]);
});
test('persists only rebuildable selections, restores order and regenerates temporary tiles',async()=>{
  const {store,jobs,storage}=setup();
  const first=store.add('slopeSteepness',aoi(),{});
  const second=store.add('soilTexture',aoi(),{});await flush();
  jobs.forEach(job=>job.resolve({status:'ready',layer:{url:'temporary-secret-free-tile'}}));await flush();
  store.patch(first,{opacity:.35,visible:false});store.move(first,-1);
  const saved=storage.setItem.mock.lastCall;
  expect(saved[0]).toBe(PRESET_STORAGE_KEY);expect(saved[1]).not.toContain('temporary');
  const request=vi.fn(()=>Promise.resolve({status:'ready',layer:{url:'renewed'}}));
  const restored=new PresetLayerStore(request,{getItem:()=>saved[1],setItem:vi.fn()});restored.start();await flush();
  expect(restored.rows.map(row=>row.presetId)).toEqual(['slopeSteepness','soilTexture']);
  expect(restored.rows[0]).toMatchObject({visible:false,opacity:.35,layer:{url:'renewed'}});
  expect(request).toHaveBeenCalledTimes(2);expect(second).not.toBe(first);
});
test('stop prevents queued work starting and resume is safe after effect replay',async()=>{
  const {store,jobs,request}=setup(1);
  store.add('lclu',aoi(),{});store.add('soilTexture',aoi(),{});await flush();store.stop();
  jobs[0].resolve({status:'ready',layer:{url:'stale'}});await flush();expect(request).toHaveBeenCalledTimes(1);
  store.resume();await flush();expect(request).toHaveBeenCalledTimes(2);
});
test('preset scope retains opacity/order and visibility through mode switches and style reload',()=>{
  let styleReady;
  const engine={onStyleReady:fn=>{styleReady=fn;},addLayer:vi.fn(),removeLayer:vi.fn(),setVisibility:vi.fn(),setOpacity:vi.fn(),moveLayer:vi.fn(),setBasicActive:vi.fn()};
  const service=new MapService(engine), scope=service.scope('basic:presets');
  const spec={kind:'gee',url:'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',metadata:{source:'ESA',observed_at:'2021'},visualization:{min:1,max:2,palette:['00008b','ff0000']},legend:{type:'categorical',labels:['Water','Seasonal']}};
  scope.addLayer({...spec,id:'one'});scope.addLayer({...spec,id:'two'});
  scope.setOpacity('one',.3);scope.setVisibility('two',false);scope.setOrder(['one','two']);
  service.setMode('agent');expect(engine.setVisibility).toHaveBeenCalledWith(service.physical('basic:presets','one'),false);
  styleReady();service.setMode('basic');
  expect(engine.setVisibility).toHaveBeenLastCalledWith(service.physical('basic:presets','one'),true);
  const added=engine.addLayer.mock.calls.slice(-2).map(call=>call[0]);
  expect(added.map(layer=>layer.id)).toEqual([service.physical('basic:presets','two'),service.physical('basic:presets','one')]);
  expect(added[1].opacity).toBe(.3);expect(scope.listLayers()).toHaveLength(2);
  const normalized=normalizeLayer(normalizeLayer({...spec,id:'legend'}));
  expect(normalized.legend.type).toBe('categorical');expect(normalized.metadata.observedAt).toBe('2021');
  expect(presetRequestKey('lclu',aoi(),{})).toBe(presetRequestKey('lclu',aoi(),{}));
});
