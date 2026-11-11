import { formatGeometryArea, geometryAreaSquareMeters } from '../../utils/geometryArea.js';

/** Display-only projection; editing drafts never become confirmed area labels. */
export function regionPresentation(region, mapReady) {
  if (region?.editing) {
    const state = region.confirmed ? 'editing' : region.canConfirm ? 'ready' : 'drawing';
    return { state, label: region.error ? 'Check polygon' : state === 'editing' ? 'Editing area…'
      : state === 'ready' ? 'Confirm area on map' : 'Drawing polygon…',
    hint: region.error || (region.canConfirm ? '' : 'Finish or cancel drawing to send') };
  }
  if (region?.confirmed) {
    const area = formatGeometryArea(geometryAreaSquareMeters(region.confirmed));
    return { state: 'confirmed', label: area ? `Area 1 · ${area}` : 'Area 1', hint: '' };
  }
  return { state: 'viewport', label: 'Current map view', hint: mapReady ? '' : 'Waiting for map' };
}
