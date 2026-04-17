const DB_NAME = 'satgpt-business-layers';
const DB_VERSION = 1;
const STORE_NAME = 'layers';
const SESSION_STORAGE_KEY = 'satgpt-agent-session-id';

const BUSINESS_LAYER_SOURCES = new Set([
  'upload',
  'draw',
  'place_search',
  'edited',
  'fishnet',
  'bounds',
  'legacy_polygon',
]);

const DRAW_LIKE_SOURCES = new Set(['draw', 'edited', 'fishnet', 'bounds', 'legacy_polygon']);

function getCenterFromBounds(bounds) {
  if (!bounds) {
    return null;
  }

  const west = Number(bounds.west);
  const south = Number(bounds.south);
  const east = Number(bounds.east);
  const north = Number(bounds.north);

  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }

  return {
    lng: (west + east) / 2,
    lat: (south + north) / 2,
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error || new Error('Failed to open business layer database.'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'storage_key' });
        store.createIndex('namespace', 'namespace', { unique: false });
        store.createIndex('updated_at', 'updated_at', { unique: false });
      }
    };
  });
}

function normalizeTimestamp(value) {
  if (typeof value === 'string' && value) {
    return value;
  }
  return new Date().toISOString();
}

function buildStorageKey(namespace, id) {
  return `${namespace}::${id}`;
}

function normalizeSortIndex(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function withTransaction(mode, callback) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Business layer transaction failed.'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error('Business layer transaction aborted.'));
    };

    callback(store, resolve, reject);
  }));
}

export function createAgentSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}`;
}

export function getStoredAgentSessionId() {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return createAgentSessionId();
  }

  const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const nextId = createAgentSessionId();
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, nextId);
  return nextId;
}

export function persistAgentSessionId(sessionId) {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export function isBusinessLayerAoiSource(source) {
  return BUSINESS_LAYER_SOURCES.has(String(source || '').toLowerCase());
}

export function buildBusinessLayerRecordFromAoi(aoi, overrides = {}) {
  if (!aoi?.geojson) {
    return null;
  }

  const now = normalizeTimestamp(overrides.updated_at);
  const id = overrides.id || aoi.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `layer-${Date.now()}`);
  const geometry = aoi.geojson?.geometry || null;
  const source = overrides.source || aoi.source || 'upload';
  const label = overrides.label || aoi.label || aoi.geojson?.properties?.label || 'Business layer';
  const createdAt = normalizeTimestamp(overrides.created_at || aoi.created_at);
  const bounds = overrides.bounds || aoi.bounds || null;
  const center = overrides.center || aoi.center || getCenterFromBounds(bounds);

  const isDrawLike = DRAW_LIKE_SOURCES.has(String(source || '').toLowerCase());

  return {
    id,
    label,
    kind: overrides.kind || (isDrawLike ? 'drawn_aoi' : 'uploaded_aoi'),
    source,
    geometry_type: geometry?.type || null,
    bounds,
    center,
    geojson: overrides.geojson || aoi.geojson,
    created_at: createdAt,
    updated_at: now,
    is_active: Boolean(overrides.is_active ?? true),
    is_visible: Boolean(overrides.is_visible ?? true),
    origin: overrides.origin || (isDrawLike ? 'draw' : 'upload'),
    layer_role: overrides.layer_role || 'business_layer',
  };
}

export function buildAoiFromBusinessLayerRecord(record) {
  if (!record?.geojson) {
    return null;
  }

  return {
    version: 1,
    id: record.id,
    source: record.source || 'upload',
    kind: record.geojson?.geometry?.type === 'MultiPolygon' ? 'multipolygon' : 'polygon',
    label: record.label || 'Business layer scope',
    bounds: record.bounds || null,
    center: record.center || getCenterFromBounds(record.bounds),
    geojson: record.geojson,
    created_at: record.created_at,
    updated_at: record.updated_at,
    origin: record.origin,
    legacy: {
      AoI_cords: record.geojson?.geometry?.type === 'Polygon'
        ? record.geojson.geometry.coordinates?.[0] || []
        : [],
    },
  };
}

export async function listBusinessLayerRecords(namespace) {
  if (!namespace) {
    return [];
  }

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('namespace');
    const request = index.getAll(namespace);

    request.onerror = () => {
      db.close();
      reject(request.error || new Error('Failed to list business layers.'));
    };

    request.onsuccess = () => {
      db.close();
      const records = (request.result || [])
        .map(({ storage_key, namespace: recordNamespace, ...record }) => ({
          ...record,
          is_visible: record.is_visible !== false,
        }))
        .sort((left, right) => {
          const leftSortIndex = Number.isFinite(left.sort_index) ? left.sort_index : null;
          const rightSortIndex = Number.isFinite(right.sort_index) ? right.sort_index : null;

          if (leftSortIndex !== null || rightSortIndex !== null) {
            return normalizeSortIndex(leftSortIndex, Number.MAX_SAFE_INTEGER)
              - normalizeSortIndex(rightSortIndex, Number.MAX_SAFE_INTEGER);
          }

          const createdDiff = String(left.created_at || '').localeCompare(String(right.created_at || ''));
          if (createdDiff !== 0) {
            return createdDiff;
          }

          const updatedDiff = String(left.updated_at || '').localeCompare(String(right.updated_at || ''));
          if (updatedDiff !== 0) {
            return updatedDiff;
          }

          return String(left.label || '').localeCompare(String(right.label || ''));
        });
      resolve(records);
    };
  });
}

export async function saveBusinessLayerRecords(namespace, records = []) {
  if (!namespace) {
    return;
  }

  const normalizedRecords = records
    .filter((record) => record?.id)
    .map((record, index) => ({
      ...record,
      namespace,
      sort_index: index,
      updated_at: normalizeTimestamp(record.updated_at),
      created_at: normalizeTimestamp(record.created_at),
      storage_key: buildStorageKey(namespace, record.id),
    }));

  await withTransaction('readwrite', (store) => {
    const index = store.index('namespace');
    const request = index.openCursor(namespace);

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }

      normalizedRecords.forEach((record) => {
        store.put(record);
      });
    };

    request.onerror = () => {
      throw request.error || new Error('Failed to sync business layer namespace.');
    };
  });
}

export async function deleteBusinessLayerRecord(namespace, id) {
  if (!namespace || !id) {
    return;
  }

  await withTransaction('readwrite', (store) => {
    store.delete(buildStorageKey(namespace, id));
  });
}

export async function clearBusinessLayerNamespace(namespace) {
  if (!namespace) {
    return;
  }

  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('namespace');
    const request = index.openCursor(namespace);

    request.onerror = () => {
      db.close();
      reject(request.error || new Error('Failed to clear business layer namespace.'));
    };

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }
      db.close();
      resolve();
    };
  });
}
