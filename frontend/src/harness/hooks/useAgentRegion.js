import { useEffect, useMemo, useRef, useState } from 'react';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useSharedMap } from '../../map/SharedMapContext';
import { RegionSelection } from '../map/regionSelection';
import { getDrawFeaturesFromAoi } from '../../utils/aoi';

const readOnly = {
  onSetup() { this.setActionableState({ trash: false, combineFeatures: false, uncombineFeatures: false }); return {}; },
  toDisplayFeatures(_state, feature, display) { feature.properties.active = 'false'; display(feature); },
};

/** Projection onto the existing engine's isolated Agent extension port. */
export function useAgentRegion(conversationId, messages, active) {
  const shared = useSharedMap();
  const [, refresh] = useState(0);
  const update = () => refresh(n => n + 1);
  const draw = useRef(null);
  const selection = useMemo(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* The live session also works without browser storage. */ }
    return new RegionSelection(conversationId, storage, messages);
  }, [conversationId]);
  useEffect(() => {
    const port = shared.agentDrawPort;
    if (!port || !shared.ready || !conversationId) return undefined;
    const control = new MapboxDraw({ displayControlsDefault: false, controls: {}, keybindings: false,
      defaultMode: 'read_only', modes: { ...MapboxDraw.modes, read_only: readOnly } });
    port.addControl(control);
    draw.current = control;
    const restore = () => {
      control.changeMode('read_only'); control.deleteAll();
      if (selection.confirmed) control.add({ type: 'Feature', properties: {}, geometry: selection.confirmed });
    };
    restore();
    const changed = () => {
      if (!selection.editing) return;
      selection.update(control.getAll().features, control.getMode() !== 'draw_polygon'); update();
    };
    for (const event of ['draw.create', 'draw.update', 'draw.delete', 'draw.modechange']) port.on(event, changed);
    draw.current.restore = restore;
    update();
    return () => {
      for (const event of ['draw.create', 'draw.update', 'draw.delete', 'draw.modechange']) port.off(event, changed);
      port.removeControl(control); if (draw.current === control) draw.current = null;
    };
  }, [shared.agentDrawPort, shared.ready, conversationId, selection]);
  useEffect(() => {
    if (!active && selection.editing) { selection.cancel(); draw.current?.restore(); update(); }
  }, [active, selection]);
  const begin = () => {
    if (!active || !draw.current) return false;
    selection.begin();
    const control = draw.current;
    control.changeMode('read_only'); control.deleteAll();
    const features = getDrawFeaturesFromAoi({ geojson: selection.confirmed });
    if (features.length) {
      const ids = control.add({ type: 'FeatureCollection', features });
      control.changeMode('direct_select', { featureId: ids[0] });
    } else control.changeMode('draw_polygon');
    update(); return true;
  };
  return {
    confirmed: selection.confirmed, editing: selection.editing, error: selection.error,
    canConfirm: selection.editing && selection.complete && !selection.error,
    ready: shared.ready && Boolean(conversationId && draw.current),
    begin,
    confirm: () => { const ok = selection.confirm(); if (ok) draw.current?.restore(); update(); return ok; },
    cancel: () => { selection.cancel(); draw.current?.restore(); update(); },
    clear: () => { selection.clear(); draw.current?.restore(); update(); },
    snapshot: () => selection.snapshot(),
  };
}
