import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, Droplets, Flame, Mountain } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useSharedMap } from '../map/SharedMapContext';
import { presetLayerCatalog, presetById, presetThemes } from '../config/presetLayerCatalog';
import { aoiKey } from './PresetLayerStore';
import usePresetLayers from '../hooks/usePresetLayers';
import PresetMapController from './PresetMapController';
import PresetParameterForm from './PresetParameterForm';
import PresetLayerCard from './PresetLayerCard';
import './presets.css';
import LayerPanel from '../map/LayerPanel';

const labels = { flood: 'Flood', wildfire: 'Wildfire', landslide: 'Landslide' };
const icons = { flood: Droplets, wildfire: Flame, landslide: Mountain };
export default function BasicLayerWorkspace() {
  const { selectedAOI, setCountries, aoiStorageError, is3DEnabled, setIs3DEnabled,
    isBuildingsEnabled, setIsBuildingsEnabled } = useAppContext();
  const { service } = useSharedMap();
  const { rows, store } = usePresetLayers();
  const [theme, setTheme] = useState('flood');
  const [selected, setSelected] = useState('singleInundationEvent');
  const [editing, setEditing] = useState(null);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.('(max-width: 760px)').matches || false);
  const [layersOpen, setLayersOpen] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    fetch('/assets/data/countries.json').then(response => response.json()).then(setCountries).catch(() => {});
  }, [setCountries]);
  const selectPreset = id => { setSelected(id); setEditing(null); setNotice(''); };
  const apply = params => {
    const id = store.add(selected, selectedAOI, params, editing?.id);
    setNotice(editing && id === editing.id ? 'Layer updated using the selected study area.' : 'Selection added or already present in Current layers.');
    setEditing(null); setLayersOpen(true);
    if (window.matchMedia?.('(max-width: 760px)').matches) setCollapsed(true);
  };
  const edit = row => {
    setSelected(row.presetId);
    setEditing(row);
    if (row.presetId && presetById(row.presetId).theme !== 'context') setTheme(presetById(row.presetId).theme);
    setCollapsed(false);
    setNotice('Select a different grid on the map if needed, then apply your changes.');
  };
  const renderList = (entries, title) => <section className="preset-list"><h3>{title}</h3>{entries.map(preset => <div key={preset.key} className={`preset-catalog-item${selected === preset.key ? ' is-selected' : ''}`}>
    <button type="button" className="preset-select" aria-expanded={selected === preset.key} onClick={() => selectPreset(preset.key)}>
      <Layers size={16} /><span><strong>{preset.title}</strong><small>{preset.model ? 'Model-based index' : preset.detailText || 'JRC · 1984–2021'}</small></span><ChevronRight size={15} />
    </button>
    {selected === preset.key ? <PresetParameterForm key={`${preset.key}-${editing?.id || 'new'}`} preset={preset} initialParams={editing?.params}
      editing={Boolean(editing)} disabled={!selectedAOI} onApply={apply} onCancel={editing ? () => setEditing(null) : undefined} /> : null}
  </div>)}</section>;
  return <div className={`basic-preset-workspace${collapsed ? ' library-collapsed' : ''}`}>
    <PresetMapController rows={rows} store={store} />
    {collapsed ? <button type="button" className="preset-library-open" aria-label="Open Layer library" onClick={() => setCollapsed(false)}><Layers size={17} />Layer library</button> :
      <aside className="preset-library" aria-label="Layer library">
        <header><h2>Layer library</h2><button type="button" aria-label="Collapse Layer library" onClick={() => setCollapsed(true)}><ChevronLeft size={19} /></button></header>
        <div className="preset-library-scroll">
          <nav className="preset-themes" aria-label="Hazard theme">{presetThemes.map(id => { const Icon = icons[id]; return <button key={id} type="button" aria-pressed={theme === id} onClick={() => { setTheme(id); selectPreset(presetLayerCatalog.find(preset => preset.theme === id).key); }}><Icon size={16} />{labels[id]}</button>; })}</nav>
          {aoiStorageError ? <p className="preset-notice" role="alert">{aoiStorageError}</p> : null}
          {notice ? <p className="preset-notice" role="status">{notice}</p> : null}
          {renderList(presetLayerCatalog.filter(preset => preset.theme === theme), `${labels[theme]} presets`)}
          {renderList(presetLayerCatalog.filter(preset => preset.theme === 'context'), 'Context')}
          <details className="preset-map-options"><summary>Map display</summary><label><input type="checkbox" checked={is3DEnabled} onChange={event => setIs3DEnabled(event.target.checked)} />3D terrain</label>
            <label><input type="checkbox" checked={isBuildingsEnabled} onChange={event => setIsBuildingsEnabled(event.target.checked)} />Buildings</label></details>
        </div>
      </aside>}
    <LayerPanel count={rows.length} open={layersOpen} onOpenChange={setLayersOpen} className="preset-current-layers" scrollClassName="preset-current-scroll">
      {rows.length ? rows.map((row, index) => <PresetLayerCard key={row.id} row={row} store={store} first={index === 0} last={index === rows.length - 1}
        stale={aoiKey(row.aoi) !== aoiKey(selectedAOI)} onEdit={edit} onFocus={row => service?.scope('basic:presets').setView({ bounds: [row.aoi.bounds.west, row.aoi.bounds.south, row.aoi.bounds.east, row.aoi.bounds.north] })} />)
        : <p className="preset-empty">Select a grid cell on the map, then load a preset.</p>}
    </LayerPanel>
  </div>;
}
