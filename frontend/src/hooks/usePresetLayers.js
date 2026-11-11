import { useEffect, useState, useSyncExternalStore } from 'react';
import { PresetLayerStore } from '../presets/PresetLayerStore';
import { requestPresetLayer } from '../api/presetLayers';

export default function usePresetLayers() {
  const [store] = useState(() => new PresetLayerStore(requestPresetLayer));
  const rows = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => { store.resume(); return () => store.stop(); }, [store]);
  return { rows, store };
}
