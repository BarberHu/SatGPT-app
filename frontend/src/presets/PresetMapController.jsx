import { useEffect, useMemo, useRef } from 'react';
import { useSharedMap } from '../map/SharedMapContext';

/** The sole owner of preset map layers; presentation never touches native APIs. */
export default function PresetMapController({ rows, store }) {
  const { service } = useSharedMap();
  const scope = useMemo(() => service?.scope('basic:presets'), [service]);
  const installed = useRef(new Map());
  useEffect(() => {
    if (!scope) return undefined;
    const stop = scope.subscribeTileStatus(event => {
      const row = store.snapshot().find(row => row.id === event.id);
      if (row?.layer?.url === event.url && row.tileStatus !== event.state)
        store.patch(row.id, { tileStatus: event.state });
    });
    return () => { stop(); for (const id of installed.current.keys()) scope.removeLayer(id); installed.current.clear(); };
  }, [scope, store]);
  useEffect(() => {
    if (!scope) return;
    const ready = rows.filter(row => row.status === 'ready' && row.layer);
    for (const id of installed.current.keys()) if (!ready.some(row => row.id === id)) { scope.removeLayer(id); installed.current.delete(id); }
    for (const row of ready) {
      if (installed.current.get(row.id) !== row.layer) {
        scope.addLayer({ ...row.layer, visible: row.visible, opacity: row.opacity });
        installed.current.set(row.id, row.layer);
      } else {
        scope.setVisibility(row.id, row.visible); scope.setOpacity(row.id, row.opacity);
      }
    }
    scope.setOrder(ready.map(row => row.id));
  }, [rows, scope]);
  return null;
}
