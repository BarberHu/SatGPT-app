import {
  listBusinessLayerRecords,
  saveBusinessLayerRecords,
} from '../utils/businessLayerStore';
import { syncBusinessLayers } from '../services/agentApi';

const normalizeRevisionRecord = (record, index) => ({
  id: record?.id || '',
  index,
  label: record?.label || '',
  source: record?.source || '',
  is_active: Boolean(record?.is_active),
  is_visible: record?.is_visible !== false,
  bounds: record?.bounds || null,
  geojson: record?.geojson || null,
});

export const buildBusinessLayerRevision = (records = []) => JSON.stringify(
  (records || []).map(normalizeRevisionRecord)
);

export const createBusinessLayerRepository = ({
  listRecords = listBusinessLayerRecords,
  saveRecords = saveBusinessLayerRecords,
  syncRecords = syncBusinessLayers,
} = {}) => ({
  load(namespace) {
    return listRecords(namespace);
  },

  saveLocal(namespace, records) {
    return saveRecords(namespace, records);
  },

  async save(namespace, records, { signal } = {}) {
    await saveRecords(namespace, records);
    return syncRecords({
      store_key: namespace,
      store_namespace: 'business_layer_store',
      layers: records,
    }, { signal });
  },
});

const businessLayerRepository = createBusinessLayerRepository();

export default businessLayerRepository;
