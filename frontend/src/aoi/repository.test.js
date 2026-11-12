import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test, expect, vi } from 'vitest';
import { openBusinessLayerDb, saveBusinessLayerRecords } from '../utils/businessLayerStore';
import { createAoiRepository } from './repository';
import { aoiSnapshot, exportAoiGeoJSON, snapshotFromRecord, readBasicSelection, writeBasicSelection } from './snapshot';
import { RegionSelection, regionKey, selectionKey } from '../harness/map/regionSelection';
import { agentRegionError } from './agentValidation';
import { buildAoiFromDrawFeatures, buildAoiFromGeoJSON } from '../utils/aoi';

const polygon = { type: 'Polygon', coordinates: [[[100,10],[101,10],[101,11],[100,11],[100,10]],[[100.2,10.2],[100.4,10.2],[100.4,10.4],[100.2,10.4],[100.2,10.2]]] };
const area = () => aoiSnapshot({ geojson: polygon, label: 'River basin', source: 'draw' });
let repo;
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); localStorage.clear(); repo = createAoiRepository(); });

test('real IndexedDB commit, reopen, update, soft delete and restore preserve geometry and snapshots', async () => {
  const record = await repo.save(area());
  expect(record.revision).toBe(1);
  const snapshot = snapshotFromRecord(record);
  const other = createAoiRepository();
  expect((await other.list())[0].geojson.geometry).toEqual(polygon);
  const renamed = await other.save(snapshot, { id: record.id, expectedRevision: 1, label: 'Renamed basin' });
  expect(renamed.revision).toBe(2); expect(snapshot.label).toBe('River basin');
  expect(snapshot.aoi_ref).toEqual({ id: record.id, revision: 1 });
  const deleted = await repo.remove(renamed);
  expect(deleted.deleted_at).toBeTruthy();
  expect((await repo.list())[0].geojson.geometry).toEqual(polygon);
  expect((await repo.restore(deleted)).deleted_at).toBeNull();
});

test('two windows keep independent records, reject stale updates, and repeated save is idempotent', async () => {
  const input = area(); const a = await repo.save(input);
  expect((await repo.save(input)).id).toBe(a.id);
  const other = createAoiRepository();
  const b = await other.save(area(), { label: 'Separate copy' });
  await repo.save(a, { id: a.id, expectedRevision: 1, label: 'Updated' });
  await expect(other.save(a, { id: a.id, expectedRevision: 1, label: 'Stale overwrite' })).rejects.toThrow(/another window/);
  expect((await repo.list()).map(row => row.id).sort()).toEqual([a.id,b.id].sort());
  await expect(other.remove(a)).rejects.toThrow(/another window/);
});

test('migration covers all legacy namespaces and browser keys; retries never resurrect imports', async () => {
  const a = area(), b = area();
  await saveBusinessLayerRecords('old-tab-1', [a]); await saveBusinessLayerRecords('old-tab-2', [b]);
  localStorage.setItem('satgpt:basic-study-area:v1', JSON.stringify(a));
  localStorage.setItem(regionKey('chat-a'), JSON.stringify(polygon));
  localStorage.setItem(regionKey('cleared-chat'), 'null');
  localStorage.setItem(regionKey('broken-chat'), '{bad');
  expect(await repo.migrate()).toEqual({ imported: 4, invalid: 1 });
  const old = await new Promise(async resolve => {
    const db = await openBusinessLayerDb();
    const tx = db.transaction('layers'); const req = tx.objectStore('layers').index('namespace').getAll('old-tab-1');
    req.onsuccess = () => resolve(req.result); tx.oncomplete = () => db.close();
  });
  expect(old).toHaveLength(1); expect(old[0].id).toBe(a.id);
  const record = (await repo.list())[0]; await repo.remove(record);
  expect((await repo.migrate()).imported).toBe(0);
  expect(await repo.list()).toHaveLength(4);
  expect((await repo.list()).filter(row => row.deleted_at)).toHaveLength(1);
  expect(localStorage.getItem(regionKey('cleared-chat'))).toBe('null');
});

test('failed transaction does not claim success or change the prior record', async () => {
  const record = await repo.save(area());
  const broken = createAoiRepository(async () => {
    const db = await openBusinessLayerDb(), transaction = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
      tx.objectStore = name => { const store = objectStore(name); store.put = () => { tx.abort(); throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; return store; };
      return tx;
    }; return db;
  });
  await expect(broken.save(record, { id: record.id, expectedRevision: 1, label: 'Must not survive' })).rejects.toBeTruthy();
  expect((await repo.list())[0].label).toBe(record.label);
});

test('drawing and basic persistence keep one identity; explicit clearing survives legacy data', () => {
  const aoi = buildAoiFromDrawFeatures([{ type:'Feature', geometry:polygon, properties:{} }]);
  expect(aoi.id).toBeTruthy(); expect(aoi.geojson.properties.id).toBe(aoi.id);
  expect(buildAoiFromGeoJSON(polygon, { generateId:false }).id).toBeNull();
  localStorage.setItem('satgpt:basic-study-area:v1', JSON.stringify(aoi));
  const restored = readBasicSelection(localStorage).aoi;
  writeBasicSelection(localStorage, restored, false);
  expect(readBasicSelection(localStorage)).toEqual({ aoi: restored, outlineVisible:false });
  writeBasicSelection(localStorage, null, true);
  expect(readBasicSelection(localStorage).aoi).toBeNull();
});

test('session selections keep names and detached revisions; clear, hide and edit cancellation are independent', async () => {
  const record = await repo.save(area()), selected = snapshotFromRecord(record);
  const first = new RegionSelection('a', localStorage), second = new RegionSelection('b', localStorage);
  first.use(selected); const submitted = first.snapshot();
  first.toggleOutline(); expect(first.snapshot()).toEqual(submitted);
  expect(new RegionSelection('a',localStorage).outlineVisible).toBe(false);
  first.begin(); first.update([{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[polygon.coordinates[0]]}}], true);
  first.cancel(); expect(first.snapshot()).toEqual(polygon);
  await repo.save(record, { id:record.id, expectedRevision:1, label:'Changed in library' });
  expect(first.metadata()).toEqual({ label:'River basin',id:record.id,revision:1 });
  expect(second.snapshot()).toBeNull();
  first.clear();
  expect(new RegionSelection('a', localStorage, [{role:'user',analysis_region:polygon}]).snapshot()).toBeNull();
  expect(JSON.parse(localStorage.getItem(selectionKey('a'))).aoi).toBeNull();
  expect(await repo.list()).toHaveLength(1);
});

test('library keeps large geometries; Agent rejects limits and invalid topology without changing selection', () => {
  const first = new RegionSelection('a',localStorage); first.use(area());
  const many = {type:'MultiPolygon',coordinates:Array.from({length:33},(_,i)=>[[[i,0],[i+.1,0],[i+.1,.1],[i,0]]])};
  const saved = aoiSnapshot({geojson:many,label:'Large area'});
  expect(saved.geojson.geometry.coordinates).toHaveLength(33);
  expect(()=>first.use(saved)).toThrow(/32 polygons/); expect(first.snapshot()).toEqual(polygon);
  const outside = structuredClone(polygon); outside.coordinates[1] = [[105,10],[106,10],[106,11],[105,10]];
  expect(agentRegionError(outside)).toMatch(/Holes/);
});

test('export round-trip keeps holes and multiple polygons without exposing storage keys',async()=>{
  const geometry={type:'MultiPolygon',coordinates:[polygon.coordinates,[[[102,10],[103,10],[103,11],[102,11],[102,10]]]]};
  const record=await repo.save(aoiSnapshot({geojson:geometry,label:'Complex basin'}));
  const feature=exportAoiGeoJSON(record);
  expect(feature.storage_key).toBeUndefined();expect(feature.namespace).toBeUndefined();
  expect(aoiSnapshot({geojson:JSON.parse(JSON.stringify(feature))}).geojson.geometry).toEqual(geometry);
  feature.geometry.coordinates[0][0][0][0]=0;
  expect((await repo.list())[0].geojson.geometry).toEqual(geometry);
});
