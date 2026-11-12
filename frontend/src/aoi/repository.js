import { openBusinessLayerDb } from '../utils/businessLayerStore.js';
import { aoiSnapshot, clone, newAoiId } from './snapshot.js';

export const AOI_NAMESPACE = 'aoi-library:local:v1';
export const AOI_NOTICE_KEY = 'satgpt:aoi-library:changed';
const key = id => `${AOI_NAMESPACE}::${id}`;

/** Uses the existing database; legacy namespaces remain untouched. */
export function createAoiRepository(open = openBusinessLayerDb, storage = () => globalThis.localStorage) {
  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('layers', mode);
      let value, failure;
      tx.oncomplete = () => { db.close(); resolve(clone(value)); };
      tx.onabort = tx.onerror = () => { db.close(); reject(failure || tx.error || new Error('Local area storage failed.')); };
      const fail = error => { failure = error; try { tx.abort(); } catch { /* Transaction already aborted. */ } };
      try { work(tx.objectStore('layers'), result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  }
  const notify = () => { try { storage()?.setItem(AOI_NOTICE_KEY, newAoiId()); } catch { /* IndexedDB already committed. */ } };
  async function list() {
    return transaction('readonly', (store, done, fail) => {
      store.index('namespace').getAll(AOI_NAMESPACE).onsuccess = event => {
        try {
          const records = event.target.result.filter(row => row.record_type === 'aoi');
          for (const record of records) {
            if (!aoiSnapshot(record) || typeof record.updated_at !== 'string' || !Number.isInteger(record.revision))
              throw new Error('A saved area could not be read. Original data has been kept.');
          }
          done(records.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
        } catch (error) { fail(error); }
      };
    });
  }
  async function save(input, { id = input.id || newAoiId(), label = input.label, expectedRevision } = {}) {
    label = String(label || '').trim();
    if (!label || label.length > 100) throw new Error('Use an area name between 1 and 100 characters.');
    const aoi = aoiSnapshot(input, { id, label });
    const result = await transaction('readwrite', (store, done, fail) => {
      store.get(key(id)).onsuccess = event => {
        try {
        const previous = event.target.result;
        if (previous && expectedRevision == null) {
          if (!previous.deleted_at && previous.label === label && JSON.stringify(previous.geojson.geometry) === JSON.stringify(aoi.geojson.geometry)) return done(previous);
          return fail(new Error('This area already exists. Reload it before saving changes, or save as new.'));
        }
        if ((previous?.revision ?? null) !== (expectedRevision ?? null) || previous?.deleted_at)
          return fail(new Error('This area changed in another window or was deleted. Reload it before saving.'));
        const now = new Date().toISOString();
        const record = { ...aoi, aoi_ref: null, edit_ref: null, schema_version: 2, record_type: 'aoi',
          namespace: AOI_NAMESPACE, storage_key: key(id), revision: (previous?.revision || 0) + 1,
          created_at: previous?.created_at || now, updated_at: now, deleted_at: null };
        store.put(record); done(record);
        } catch (error) { fail(error); }
      };
    });
    notify(); return result;
  }
  async function setDeleted(record, deleted) {
    const result = await transaction('readwrite', (store, done, fail) => {
      store.get(key(record.id)).onsuccess = event => {
        try {
        const previous = event.target.result;
        if (!previous || previous.revision !== record.revision) return fail(new Error('This area changed in another window. Reload the list.'));
        const now = new Date().toISOString();
        const next = { ...previous, revision: previous.revision + 1, updated_at: now, deleted_at: deleted ? now : null };
        store.put(next); done(next);
        } catch (error) { fail(error); }
      };
    });
    notify(); return result;
  }
  async function migrate() {
    const legacy = await transaction('readonly', (store, done) => {
      store.getAll().onsuccess = e => done(e.target.result.filter(row => row.namespace !== AOI_NAMESPACE)
        .map(row => ({ key: `indexeddb:${row.storage_key}`, input: row })));
    });
    const local = storage();
    if (local) for (let i = 0; i < local.length; i++) {
      const name = local.key(i);
      if (name !== 'satgpt:basic-study-area:v1' && !name?.startsWith('satgpt:agent:analysis-region:v1:')) continue;
      const text = local.getItem(name);
      try {
        const value = JSON.parse(text);
        if (value) legacy.push({ key: `localstorage:${name}`, input: value.geojson ? value : {
          geojson: value, source: 'draw', label: `Recovered area · ${name.slice(-12)}` } });
      } catch { legacy.push({ key: name, input: null }); }
    }
    let invalid = 0;
    const candidates = legacy.flatMap(item => {
      try { const aoi = aoiSnapshot(item.input); if (!aoi) throw new Error(); return [{ ...item, aoi }]; }
      catch { invalid++; return []; }
    });
    const result = await transaction('readwrite', (store, done, fail) => {
      const summary = { imported: 0, invalid }; done(summary);
      for (const item of candidates) {
        const marker = key(`migration:${item.key}`);
        store.get(marker).onsuccess = event => {
          try {
          if (event.target.result) return;
          const id = newAoiId(), now = new Date().toISOString();
          store.put({ ...item.aoi, id, geojson: { ...item.aoi.geojson, properties: { ...item.aoi.geojson.properties, id } },
            aoi_ref: null, edit_ref: null, schema_version: 2, record_type: 'aoi', namespace: AOI_NAMESPACE,
            storage_key: key(id), revision: 1, created_at: item.input.created_at || now, updated_at: now, deleted_at: null });
          // Marker and area commit together. A deleted or edited import is never resurrected.
          store.put({ storage_key: marker, namespace: AOI_NAMESPACE, record_type: 'migration', area_id: id });
          summary.imported++;
          } catch (error) { fail(error); }
        };
      }
    });
    if (result.imported) notify();
    return result;
  }
  return { list, save, migrate, remove: record => setDeleted(record, true), restore: record => setDeleted(record, false) };
}

export const aoiRepository = createAoiRepository();
