import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAPBOX_STREETS_V8 } from '../map/layerSpec';
import { DEFAULT_ROAD_LEVELS } from '../map/roadLevels';
import { aoiKey } from '../presets/PresetLayerStore';

export const ROAD_NETWORK = { idPrefix: 'basic-road-network', name: 'Road network', sourceLayer: 'road', renderAs: 'line', levels: DEFAULT_ROAD_LEVELS };

export default function useGridTileLayers(selectedAOI, service, { idPrefix, name, sourceLayer, renderAs, levels = null }) {
  const selection = useMemo(() => aoiKey(selectedAOI), [selectedAOI]);
  const scope = useMemo(() => service?.scope('basic:presets'), [service]);
  const nextId = useRef(0);
  const installed = useRef(new Map());
  const [rows, setRows] = useState([]);
  const current = rows.find(row => row.selection === selection);
  const area = selectedAOI?.bounds;

  const updateRow = useCallback((id, update) => {
    setRows(previous => {
      const row = previous.find(item => item.layer.id === id);
      if (!row) return previous;
      const next = update(row);
      return next === row ? previous : previous.map(item => item === row ? next : item);
    });
  }, []);
  const updateStatus = useCallback((id, status) => {
    updateRow(id, row => row.status === status ? row : { ...row, status });
  }, [updateRow]);

  useLayoutEffect(() => {
    if (!scope) return undefined;
    const mounted = installed.current;
    const unsubscribe = scope.subscribeTileStatus(event => updateStatus(event.id, event.state));
    return () => {
      unsubscribe();
      for (const id of mounted.keys()) scope.removeLayer(id);
      mounted.clear();
    };
  }, [scope, updateStatus]);

  useLayoutEffect(() => {
    if (!scope) return;
    const mounted = installed.current;
    const next = new Map(rows.map(row => [row.layer.id, row]));
    for (const id of mounted.keys()) {
      if (next.has(id)) continue;
      scope.removeLayer(id);
      mounted.delete(id);
    }
    for (const [id, row] of next) {
      const previous = mounted.get(id);
      mounted.set(id, row);
      if (!previous) {
        try {
          scope.addLayer({ ...row.layer, visible: row.visible, ...(row.levels && { roadLevels: row.levels }) });
        } catch {
          updateStatus(id, 'error');
        }
      } else {
        if (previous.visible !== row.visible) scope.setVisibility(id, row.visible);
        if (previous.levels !== row.levels) scope.setRoadLevels(id, row.levels);
      }
    }
  }, [rows, scope, updateStatus]);

  const disabled = !area || !scope || Boolean(current && current.status !== 'error');
  const newLayerId = () => `${idPrefix}-${++nextId.current}`;

  function retry(id) {
    if (!scope || !rows.some(row => row.layer.id === id && row.status === 'error')) return;
    const replacementId = newLayerId();
    updateRow(id, row => row.status === 'error'
      ? { ...row, status: 'loading', layer: { ...row.layer, id: replacementId } }
      : row);
  }

  function load() {
    if (disabled) return;
    if (current) { retry(current.layer.id); return; }
    const { west, south, east, north } = area;
    const row = {
      selection,
      status: 'loading',
      visible: true,
      levels,
      layer: {
        id: newLayerId(),
        name,
        kind: 'vector',
        url: MAPBOX_STREETS_V8,
        sourceLayer,
        renderAs,
        bounds: [west, south, east, north],
      },
    };
    setRows(previous => previous.some(item => item.selection === selection) ? previous : [row, ...previous]);
  }

  return {
    load,
    retry,
    rows,
    current,
    disabled,
    toggle: id => updateRow(id, row => ({ ...row, visible: !row.visible })),
    toggleLevel: (id, level) => updateRow(id, row => row.levels ? ({
      ...row,
      levels: row.levels.includes(level)
        ? row.levels.filter(item => item !== level)
        : [...row.levels, level],
    }) : row),
    remove: id => setRows(previous => previous.filter(row => row.layer.id !== id)),
  };
}
