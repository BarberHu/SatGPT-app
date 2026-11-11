import { buildAoiFromDrawFeatures, buildAoiFromGeoJSON } from '../../utils/aoi.js';
import { geometryAreaSquareMeters } from '../../utils/geometryArea.js';

const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
export const regionKey = id => `satgpt:agent:analysis-region:v1:${id}`;

export function drawnRegionError(geometry) {
  if (!geometry) return 'Draw a polygon with at least three distinct vertices and a non-zero area.';
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = polygons.flat(2);
  if (points.length > 2048) return 'Use a simpler area (at most 2048 vertices).';
  if (Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])) > 180) return 'Areas crossing the antimeridian are not supported.';
  const area = geometryAreaSquareMeters(geometry);
  return area == null || area < 1 || area > 5e12 ? 'Choose an area between 1 m² and 5 million km².' : '';
}

/** One session's reversible edit transaction. Request snapshots are detached. */
export class RegionSelection {
  constructor(id, storage, messages = []) {
    this.id = id; this.storage = storage; this.confirmed = null; this.editing = false;
    this.draft = null; this.error = ''; this.complete = false;
    let saved;
    try { saved = storage?.getItem(regionKey(id)); } catch { /* Memory-only fallback. */ }
    if (saved != null) {
      try { this.confirmed = this.validGeometry(JSON.parse(saved)); } catch { /* Ignore malformed new-key data only. */ }
    } else {
      const last = [...messages].reverse().find(m => m.role === 'user' && Object.hasOwn(m, 'analysis_region'));
      this.confirmed = this.validGeometry(last?.analysis_region);
    }
  }
  validGeometry(geometry) {
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
    return clone(buildAoiFromGeoJSON(geometry)?.geojson.geometry);
  }
  begin() { this.editing = true; this.draft = clone(this.confirmed); this.complete = Boolean(this.draft); this.error = ''; }
  update(features, complete) {
    const aoi = buildAoiFromDrawFeatures(features, { source: 'draw', label: 'Drawn analysis area' });
    this.draft = clone(aoi?.geojson.geometry);
    this.complete = complete && Boolean(this.draft);
    this.error = complete ? drawnRegionError(this.draft) : '';
  }
  persist() { try { this.storage?.setItem(regionKey(this.id), JSON.stringify(this.confirmed)); } catch { /* Keep live selection. */ } }
  confirm() {
    if (!this.editing || !this.complete || !this.draft || this.error) return false;
    this.confirmed = clone(this.draft); this.editing = false; this.persist(); return true;
  }
  cancel() { this.editing = false; this.draft = null; this.error = ''; }
  clear() { this.cancel(); this.confirmed = null; this.persist(); }
  snapshot() {
    if (this.editing) throw new Error('Finish or cancel area editing before sending.');
    return clone(this.confirmed);
  }
}
