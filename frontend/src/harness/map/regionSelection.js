import { buildAoiFromDrawFeatures } from '../../utils/aoi.js';
import { aoiSnapshot, aoiMetadata, clone } from '../../aoi/snapshot.js';
import { agentRegionError } from '../../aoi/agentValidation.js';

export const regionKey = id => `satgpt:agent:analysis-region:v1:${id}`;
export const selectionKey = id => `satgpt:agent:analysis-region:v2:${id}`;

/** Session-local selection and edit transaction; every send captures detached geometry. */
export class RegionSelection {
  constructor(id, storage, messages = []) {
    this.id = id; this.storage = storage; this.aoi = null; this.confirmed = null;
    this.editing = false; this.draft = null; this.draftAoi = null; this.complete = false;
    this.error = ''; this.persistenceError = ''; this.outlineVisible = true;
    if (!id) return;
    try {
      const current = storage?.getItem(selectionKey(id));
      if (current != null) {
        const value = JSON.parse(current);
        if (value?.schema_version !== 2 || !Object.hasOwn(value, 'aoi')) throw new Error('Unrecognized saved selection.');
        this.aoi = aoiSnapshot(value.aoi); this.outlineVisible = value.outline_visible !== false;
      } else {
        const saved = storage?.getItem(regionKey(id));
        const last = [...messages].reverse().find(m => m.role === 'user' && Object.hasOwn(m, 'analysis_region'));
        const geometry = saved != null ? JSON.parse(saved) : last?.analysis_region;
        if (geometry) this.aoi = aoiSnapshot({ geojson: geometry, source: 'draw', label: last?.analysis_aoi?.label || 'Area 1' });
      }
      this.confirmed = clone(this.aoi?.geojson.geometry);
      if (this.confirmed) this.error = agentRegionError(this.confirmed);
    } catch { this.persistenceError = 'The previous selection could not be read. Original data has been kept.'; }
  }
  begin(input = this.aoi) {
    if (input) { const error = agentRegionError(input.geojson?.geometry || input); if (error) throw new Error(error); }
    this.editing = true; this.draftAoi = aoiSnapshot(input); this.draft = clone(this.draftAoi?.geojson.geometry);
    this.complete = Boolean(this.draft); this.error = '';
  }
  update(features, complete) {
    const aoi = buildAoiFromDrawFeatures(features, { id: this.draftAoi?.id, source: 'draw', label: this.draftAoi?.label || 'Drawn analysis area' });
    this.draftAoi = aoi ? aoiSnapshot({ ...aoi, aoi_ref: null, edit_ref: this.draftAoi?.edit_ref || this.draftAoi?.aoi_ref || null }) : null;
    this.draft = clone(this.draftAoi?.geojson.geometry); this.complete = complete && Boolean(this.draft);
    this.error = complete ? agentRegionError(this.draft) : '';
  }
  attach(conversationId) {
    this.id = conversationId;
    this.persist();
  }
  persist() {
    if (!this.id) return;
    try { this.storage?.setItem(selectionKey(this.id), JSON.stringify({ schema_version: 2, aoi: this.aoi, outline_visible: this.outlineVisible })); this.persistenceError = ''; }
    catch { this.persistenceError = 'Selection is available now but could not be saved locally.'; }
  }
  use(input) {
    const aoi = aoiSnapshot(input), error = agentRegionError(aoi?.geojson.geometry);
    if (error) throw new Error(error);
    this.cancel(); this.aoi = aoi; this.confirmed = clone(aoi.geojson.geometry); this.outlineVisible = true; this.persist();
  }
  confirm() {
    if (!this.editing || !this.complete || !this.draft || this.error) return false;
    this.use(this.draftAoi); return true;
  }
  cancel() { this.editing = false; this.draft = null; this.draftAoi = null; this.error = this.confirmed ? agentRegionError(this.confirmed) : ''; }
  clear() { this.cancel(); this.aoi = this.confirmed = null; this.error = ''; this.persist(); }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; this.persist(); }
  snapshot() {
    if (this.editing) throw new Error('Finish or cancel area editing before sending.');
    if (this.error) throw new Error(this.error);
    return clone(this.confirmed);
  }
  metadata() { return aoiMetadata(this.aoi); }
}
