import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Layers, Droplets, Flame, Mountain } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useSharedMap } from '../map/SharedMapContext';
import { presetLayerCatalog, presetById, presetThemes } from '../config/presetLayerCatalog';
import { buildAoiFromBounds, buildAoiFromGeoJSON } from '../utils/aoi';
import { aoiKey } from './PresetLayerStore';
import usePresetLayers from '../hooks/usePresetLayers';
import PresetMapController from './PresetMapController';
import PresetParameterForm from './PresetParameterForm';
import PresetLayerCard from './PresetLayerCard';
import './presets.css';
import AreaControls from '../aoi/AreaControls';
import LayerPanel from '../map/LayerPanel';

const labels = { flood: 'Flood', wildfire: 'Wildfire', landslide: 'Landslide' };
const icons = { flood: Droplets, wildfire: Flame, landslide: Mountain };
export default function BasicLayerWorkspace({ active = true }) {
  const { selectedAOI, setSelectedAOI, draftAOI, setDraftAOI, gridClickEnabled, setGridClickEnabled,
    setCountries, applyDraftAoi, cancelDraftAoi, startAoiDraw, startAoiEdit, clearAoiState, isAoiEditing,
    setAoiEditorMode, aoiOutlineVisible, toggleAoiOutline, aoiStorageError, is3DEnabled, setIs3DEnabled, isBuildingsEnabled, setIsBuildingsEnabled } = useAppContext();
  const { service, ready } = useSharedMap();
  const { rows, store } = usePresetLayers();
  const [theme, setTheme] = useState('flood');
  const [selected, setSelected] = useState('singleInundationEvent');
  const [editing, setEditing] = useState(null);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.('(max-width: 760px)').matches || false);
  const [layersOpen, setLayersOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [areaToolsOpen, setAreaToolsOpen] = useState(false);
  const upload = useRef(null);
  const activeRef = useRef(active); activeRef.current = active;
  const uploadScope = useRef({ active, selectedAOI, editing: isAoiEditing, generation: 0 });
  if (uploadScope.current.active !== active || uploadScope.current.selectedAOI !== selectedAOI || uploadScope.current.editing !== isAoiEditing) {
    uploadScope.current = { active, selectedAOI, editing: isAoiEditing, generation: uploadScope.current.generation + 1 };
  }
  useEffect(() => () => { uploadScope.current.generation++; }, []);
  useEffect(() => { if (!active && isAoiEditing) cancelDraftAoi(); }, [active, isAoiEditing, cancelDraftAoi]);
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
  const edit = row => { setSelected(row.presetId); setEditing(row); if (row.presetId && presetById(row.presetId).theme !== 'context') setTheme(presetById(row.presetId).theme); setCollapsed(false); setNotice('Choose the study area and apply to update this layer.'); };
  const captureExtent = () => {
    const bounds = service?.getCurrentView()?.bounds;
    if (!bounds || bounds[0] >= bounds[2] || bounds[2] - bounds[0] > 180) { setNotice('Choose a smaller map extent that does not cross the antimeridian.'); return; }
    const aoi = buildAoiFromBounds({ west: bounds[0], south: bounds[1], east: bounds[2], north: bounds[3] }, { source: 'bounds', label: 'Captured map extent' });
    if (!aoi) { setNotice('This map extent cannot be used. Zoom in and try again.'); return; }
    setSelectedAOI(aoi); setDraftAOI(null); setGridClickEnabled(false); setNotice('Map extent captured. Panning will not change this study area.');
  };
  const loadFile = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const generation = ++uploadScope.current.generation;
    try {
      if (file.size > 2_000_000) throw new Error();
      const text = await file.text();
      if (!activeRef.current || generation !== uploadScope.current.generation) return;
      const aoi = buildAoiFromGeoJSON(JSON.parse(text), { source: 'upload', label: file.name.replace(/\.(geo)?json$/i, '') });
      if (!aoi) throw new Error();
      setSelectedAOI(aoi); setDraftAOI(null); setGridClickEnabled(false); setNotice('Study area uploaded. Apply a preset to load it.');
    } catch { if (activeRef.current && generation === uploadScope.current.generation) setNotice('Upload a valid polygon GeoJSON file smaller than 2 MB.'); }
  };
  const renderList = (entries, title) => <section className="preset-list"><h3>{title}</h3>{entries.map(preset => <div key={preset.key} className={`preset-catalog-item${selected === preset.key ? ' is-selected' : ''}`}>
    <button type="button" className="preset-select" aria-expanded={selected === preset.key} onClick={() => selectPreset(preset.key)}>
      <Layers size={16} /><span><strong>{preset.title}</strong><small>{preset.model ? 'Model-based index' : preset.detailText || 'JRC · 1984–2021'}</small></span><ChevronRight size={15} />
    </button>
    {selected === preset.key ? <PresetParameterForm key={`${preset.key}-${editing?.id || 'new'}`} preset={preset} initialParams={editing?.params}
      editing={Boolean(editing)} disabled={!selectedAOI || isAoiEditing} onApply={apply} onCancel={editing ? () => setEditing(null) : undefined} /> : null}
  </div>)}</section>;
  const matches = preset => `${preset.title} ${preset.infoText}`.toLowerCase().includes(query.toLowerCase());
  return <div className={`basic-preset-workspace${collapsed ? ' library-collapsed' : ''}`}>
    <PresetMapController rows={rows} store={store} />
    {collapsed ? <button type="button" className="preset-library-open" aria-label="Open Layer library" onClick={() => setCollapsed(false)}><Layers size={17} />Layer library</button> :
      <aside className="preset-library" aria-label="Layer library">
        <header><h2>Layer library</h2><button type="button" aria-label="Collapse Layer library" onClick={() => setCollapsed(true)}><ChevronLeft size={19} /></button></header>
        <div className="preset-library-scroll"><input className="preset-search" aria-label="Find a layer" placeholder="Find a layer" value={query} onChange={event => setQuery(event.target.value)} />
          <nav className="preset-themes" aria-label="Hazard theme">{presetThemes.map(id => { const Icon = icons[id]; return <button key={id} type="button" aria-pressed={theme === id} onClick={() => { setTheme(id); selectPreset(presetLayerCatalog.find(preset => preset.theme === id).key); }}><Icon size={16} />{labels[id]}</button>; })}</nav>
          <section className="preset-study-area"><h3>Study area</h3><strong>{selectedAOI?.label || 'Select a study area'}</strong>
            <details className="preset-area-tools" open={areaToolsOpen || !selectedAOI || isAoiEditing}
              onToggle={event => { if (selectedAOI && !isAoiEditing) setAreaToolsOpen(event.currentTarget.open); }}>
            <summary>Choose or draw an area</summary>
            {selectedAOI ? <small>{Object.values(selectedAOI.bounds).map(value => Number(value).toFixed(3)).join(', ')}</small> : null}
            <div className="preset-area-actions"><button type="button" disabled={isAoiEditing} aria-pressed={gridClickEnabled} onClick={() => setGridClickEnabled(!gridClickEnabled)}>Select grid</button>
              <button type="button" disabled={!ready || isAoiEditing} onClick={captureExtent}>Use current map extent</button>
              <button type="button" disabled={isAoiEditing} onClick={() => upload.current.click()}>Upload GeoJSON</button></div>
            <input ref={upload} type="file" accept=".json,.geojson,application/geo+json,application/json" aria-label="Upload study area" hidden onChange={loadFile} />
            <small>Draw a polygon with the map drawing tool, then use it below.</small>
            <button type="button" disabled={!ready || isAoiEditing} onClick={startAoiDraw}>Draw area</button>
            {draftAOI ? <button type="button" className="preset-use-drawing" onClick={() => { applyDraftAoi(); setGridClickEnabled(false); setNotice('Drawing applied as the study area.'); }}>Use drawn study area</button> : null}
            {isAoiEditing ? <button type="button" onClick={cancelDraftAoi}>Cancel area editing</button> : null}
            </details>
            <AreaControls compact current={selectedAOI} scopeKey={active ? 'basic' : 'inactive:basic'} disabled={!active || isAoiEditing}
              onUse={aoi => { setSelectedAOI(aoi); setDraftAOI(null); setAoiEditorMode('idle'); setGridClickEnabled(false); }}
              onEdit={startAoiEdit} onClear={clearAoiState} outlineVisible={aoiOutlineVisible} onToggleOutline={toggleAoiOutline}
              onLocate={aoi => service?.scope('basic:presets').setView({ bounds: [aoi.bounds.west,aoi.bounds.south,aoi.bounds.east,aoi.bounds.north] })} />
            {aoiStorageError ? <p role="alert">{aoiStorageError}</p> : null}
          </section>
          {notice ? <p className="preset-notice" role="status">{notice}</p> : null}
          {renderList(presetLayerCatalog.filter(preset => preset.theme === theme && matches(preset)), `${labels[theme]} presets`)}
          {renderList(presetLayerCatalog.filter(preset => preset.theme === 'context' && matches(preset)), 'Context')}
          <details className="preset-map-options"><summary>Map display</summary><label><input type="checkbox" checked={is3DEnabled} onChange={event => setIs3DEnabled(event.target.checked)} />3D terrain</label>
            <label><input type="checkbox" checked={isBuildingsEnabled} onChange={event => setIsBuildingsEnabled(event.target.checked)} />Buildings</label></details>
        </div>
      </aside>}
    <LayerPanel count={rows.length} open={layersOpen} onOpenChange={setLayersOpen} editing={isAoiEditing} className="preset-current-layers" scrollClassName="preset-current-scroll">
      {rows.length ? rows.map((row, index) => <PresetLayerCard key={row.id} row={row} store={store} first={index === 0} last={index === rows.length - 1}
        stale={aoiKey(row.aoi) !== aoiKey(selectedAOI)} onEdit={edit} onFocus={row => service?.scope('basic:presets').setView({ bounds: [row.aoi.bounds.west, row.aoi.bounds.south, row.aoi.bounds.east, row.aoi.bounds.north] })} />)
        : <p className="preset-empty">Select a study area and load a preset. Layers from different themes stay here together.</p>}
    </LayerPanel>
  </div>;
}
