import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAoiLibrary } from './AoiLibraryContext';
import { aoiSnapshot, exportAoiGeoJSON, newAoiId, snapshotFromRecord } from './snapshot.js';
import { formatGeometryArea, geometryAreaSquareMeters } from '../utils/geometryArea';
import './areas.css';

export default function AreaControls({ current, scopeKey, disabled, onUse, onEdit, onLocate, onClear,
  outlineVisible = true, onToggleOutline, historyOnly = false, hideEditAction = false }) {
  const library = useAoiLibrary();
  const [view, setView] = useState(null), [draft, setDraft] = useState(null), [label, setLabel] = useState('');
  const [target, setTarget] = useState(null), [search, setSearch] = useState(''), [deleted, setDeleted] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const saveId = useRef(null), operation = useRef(0), scope = useRef(scopeKey);
  scope.current = scopeKey;
  useEffect(() => { operation.current++; setView(null); setBusy(false); setError(''); setNotice(''); }, [scopeKey]);
  useEffect(() => () => { operation.current++; }, []);
  const run = async action => {
    const token = ++operation.current, owner = scope.current;
    setBusy(true); setError('');
    try { await action(() => token === operation.current && owner === scope.current); }
    catch (cause) { if (token === operation.current && owner === scope.current) setError(cause.message || 'Unable to save this area. Original data has been kept.'); }
    finally { if (token === operation.current) setBusy(false); }
  };
  const startSave = (input, reference = null) => {
    setDraft(aoiSnapshot(input)); setLabel(input.label || 'Analysis area'); setTarget(reference);
    saveId.current = reference || historyOnly ? newAoiId() : input.id || newAoiId(); setError(''); setView('save');
  };
  const save = asNew => run(async stillCurrent => {
    const record = await library.save(draft, { label, id: !asNew && target ? target.id : saveId.current,
      expectedRevision: !asNew && target ? target.revision : undefined });
    if (stillCurrent()) { setNotice(`“${record.label}” saved locally. Choose Use in Saved areas to apply it.`); setView(historyOnly ? null : 'library'); }
  });
  const exportArea = row => {
    const data = exportAoiGeoJSON(row);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${row.label.replace(/[^\w -]/g, '_') || 'area'}.geojson`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importFile = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const owner = scope.current, token = ++operation.current;
    try {
      if (file.size > 2_000_000) throw new Error('Choose a GeoJSON file smaller than 2 MB.');
      const input = JSON.parse(await file.text());
      if (owner !== scope.current || token !== operation.current) return;
      const aoi = aoiSnapshot({ geojson: input, source: 'upload', label: input.properties?.label || input.properties?.name || file.name.replace(/\.(geo)?json$/i, '') });
      startSave(aoi);
    } catch (cause) { if (owner === scope.current && token === operation.current) setError(cause.message || 'Unable to read this GeoJSON.'); }
  };
  const use = (row, edit) => {
    try { (edit ? onEdit : onUse)?.(snapshotFromRecord(row)); setView(null); setError(''); setNotice(''); }
    catch (cause) { setError(cause.message); }
  };
  const rows = library.records.filter(row => Boolean(row.deleted_at) === deleted && row.label.toLowerCase().includes(search.toLowerCase()));
  const duplicate = draft && library.records.some(row => !row.deleted_at && row.id !== target?.id
    && JSON.stringify(row.geojson.geometry) === JSON.stringify(draft.geojson.geometry));
  return <div className="aoi-controls">
    {!historyOnly ? <button type="button" disabled={disabled} onClick={() => { setView('library'); setError(''); library.reload(); }}>Saved areas</button> : null}
    {current ? <button type="button" disabled={disabled || !library.ready} onClick={() => startSave(current,
      historyOnly ? null : current.edit_ref || current.aoi_ref)}>{historyOnly ? 'Save this area' : 'Save area'}</button> : null}
    {!historyOnly && !hideEditAction && current && onEdit ? <button type="button" disabled={disabled} onClick={() => { try { onEdit(current); } catch (e) { setNotice(e.message); } }}>Edit area</button> : null}
    {!historyOnly && current && onToggleOutline ? <button type="button" disabled={disabled} onClick={onToggleOutline}>{outlineVisible ? 'Hide boundary' : 'Show boundary'}</button> : null}
    {!historyOnly && current && onClear ? <button type="button" disabled={disabled} onClick={onClear}>Remove selection</button> : null}
    {notice ? <small role="status">{notice}</small> : null}
    <Dialog.Root open={Boolean(view)} onOpenChange={open => { if (!open) { operation.current++; setView(null); setBusy(false); } }}>
      <Dialog.Portal><Dialog.Overlay className="aoi-dialog-overlay" /><Dialog.Content className="aoi-dialog">
        <Dialog.Title>{view === 'save' ? 'Save area' : 'Saved areas'}</Dialog.Title>
        <Dialog.Description>Saved in this browser for this site. Export GeoJSON to keep a backup or move an area to another device.</Dialog.Description>
        <Dialog.Close className="aoi-close" aria-label="Close saved areas">×</Dialog.Close>
        {error || library.error ? <p role="alert">{error || library.error}</p> : null}
        {view === 'save' ? <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); save(false); }}>
          <label>Area name<input autoFocus value={label} maxLength={100} onChange={e => setLabel(e.target.value)} /></label>
          <p>{draft && formatGeometryArea(geometryAreaSquareMeters(draft.geojson.geometry))} · {draft?.source}</p>
          {duplicate ? <p>The same geometry is already in Saved areas. You can keep a separate named copy.</p> : null}
          <div className="aoi-actions"><button type="submit" disabled={busy || !label.trim() || !library.ready}>{busy ? 'Saving…' : target ? 'Save changes' : 'Save locally'}</button>
            {target ? <button type="button" disabled={busy || !label.trim()} onClick={() => save(true)}>Save as new</button> : null}
            <button type="button" disabled={busy} onClick={() => setView(historyOnly ? null : 'library')}>Cancel</button></div>
        </form> : <>
          <div className="aoi-toolbar"><input aria-label="Find a saved area" placeholder="Find an area" value={search} onChange={e => setSearch(e.target.value)} />
            <label><input type="checkbox" checked={deleted} onChange={e => setDeleted(e.target.checked)} />Show deleted</label>
            <label className="aoi-import">Import GeoJSON<input type="file" aria-label="Import saved area GeoJSON" accept=".json,.geojson" onChange={importFile} disabled={busy || !library.ready} /></label>
            <button type="button" disabled={busy} onClick={() => run(async () => { await (library.retry || library.reload)(); })}>Retry / refresh</button></div>
          {!library.ready ? <p role="status">Saved areas are not available yet. Original data has been kept.</p> : null}
          {library.ready && !rows.length ? <p>No {deleted ? 'deleted' : 'saved'} areas found.</p> : null}
          <div className="aoi-list">{rows.map(row => <article key={row.id} aria-label={`Saved area ${row.label}`}>
            <strong>{row.label}</strong><small>{formatGeometryArea(geometryAreaSquareMeters(row.geojson.geometry))} · {row.source} · {new Date(row.updated_at).toLocaleDateString('en-US')}</small>
            <div className="aoi-actions">{row.deleted_at ? <button type="button" disabled={busy} onClick={() => run(async () => { await library.restore(row); })}>Restore</button> : <>
              <button type="button" disabled={busy || !onUse} onClick={() => use(row, false)}>Use</button>
              <button type="button" disabled={busy || !onLocate} onClick={() => onLocate?.(snapshotFromRecord(row))}>Locate</button>
              <button type="button" disabled={busy || !onEdit} onClick={() => use(row, true)}>Edit on map</button>
              <button type="button" disabled={busy} onClick={() => startSave(row, { id: row.id, revision: row.revision })}>Rename</button>
              <button type="button" disabled={busy} onClick={() => run(async () => { await library.remove(row); })}>Delete</button>
            </>}<button type="button" onClick={() => exportArea(row)}>Export GeoJSON</button></div>
          </article>)}</div>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </div>;
}
