import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePersonal } from './PersonalContext';
import LocalConfiguration from './LocalConfiguration';
import { useSharedMap } from '../map/SharedMapContext';
import { personalRequest } from './api';
import './personal.css';

const terminal = row => ['ready', 'failed', 'cancelled'].includes(row.status);
const authorize = purpose => { window.location.assign(`/api/personal/oauth/start?purpose=${purpose}`); };

export default function PersonalDialog({ open, onOpenChange, error: initialError, authorization }) {
  const account = usePersonal();
  const loginAvailable = account.ready && (account.login_available ?? account.enabled);
  const map = useSharedMap();
  const [project, setProject] = useState(''), [bucket, setBucket] = useState('');
  const [parent, setParent] = useState(''), [assets, setAssets] = useState([]), [next, setNext] = useState('');
  const [asset, setAsset] = useState(''), [uploads, setUploads] = useState([]);
  const [file, setFile] = useState(null), [destination, setDestination] = useState('');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [reducer, setReducer] = useState('median');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), key = useRef(crypto.randomUUID());
  const transfer = useRef(null);
  useEffect(() => {
    ++generation.current;
    setProject(account.connection?.project || ''); setBucket(account.connection?.bucket || '');
    setParent(''); setAssets([]); setUploads([]); setAsset(''); setFile(null); setNext(''); setError(''); setNotice(''); setBusy(false);
    return () => { ++generation.current; transfer.current?.abort.abort(); transfer.current = null; };
  }, [account.workspaceKey]);
  useEffect(() => {
    if (!open || !account.user) return undefined;
    let disposed = false;
    const update = async () => {
      try {
        const data = await personalRequest('/uploads');
        if (!disposed) { setUploads(data.uploads); await account.loadDatasets(); }
      } catch (cause) { if (!disposed) setError(cause.message); }
    };
    update(); const timer = setInterval(update, 4000);
    return () => { disposed = true; clearInterval(timer); };
  }, [open, account.workspaceKey, account.user?.owner, account.loadDatasets]);
  const run = async action => {
    if (busy) return;
    const version = generation.current; setBusy(true); setError(''); setNotice('');
    try { await action(() => version === generation.current); }
    catch (cause) { if (version === generation.current) { if (cause.name === 'AbortError') setNotice('File transfer stopped. Check the upload status below.'); else setError(cause.message); } }
    finally { if (version === generation.current) setBusy(false); }
  };
  const browse = (path = parent, token = '') => run(async current => {
    const data = await personalRequest(`/assets?parent=${encodeURIComponent(path)}&page_token=${encodeURIComponent(token)}`);
    if (current()) { setParent(path); setAssets(previous => token ? [...previous, ...data.assets] : data.assets); setNext(data.next_page_token); }
  });
  const add = name => run(async current => {
    await personalRequest('/datasets', { method: 'POST', body: { asset_id: name } });
    if (current()) { await account.loadDatasets(); setNotice('Data verified. Choose it below to use in analysis.'); }
  });
  const show = row => run(async current => {
    const bounds = map.service?.getCurrentView().bounds;
    if (!bounds) throw new Error('Show the map before displaying data.');
    await personalRequest('/display', { method: 'POST', body: { data_ref: row.id, bounds, start, end, reducer } });
    if (current()) { account.displayed(); setNotice('Layer added to the current intelligent-analysis conversation.'); }
  });
  const upload = event => { event.preventDefault(); run(async current => {
    if (!file) throw new Error('Choose a GeoTIFF or GeoJSON file.');
    const raster = /\.tiff?$/i.test(file.name);
    const limit = raster ? account.limits?.raster : account.limits?.vector;
    if (limit && file.size > limit) throw new Error('This file exceeds the configured upload limit.');
    const row = await personalRequest('/uploads', { method: 'POST', body: {
      filename: file.name, asset_id: destination, idempotency_key: key.current } });
    if (!current()) return;
    if (row.status === 'received') {
      const abort = new AbortController(); transfer.current = { id: row.id, abort };
      try { await personalRequest(`/uploads/${row.id}/content`, { method: 'PUT', body: file, signal: abort.signal, headers: { 'Content-Type': 'application/octet-stream' } }); }
      finally { if (transfer.current?.abort === abort) transfer.current = null; }
    }
    if (current()) { setNotice('File transferred. Cloud import continues independently of chat.'); setFile(null);
      setUploads((await personalRequest('/uploads')).uploads); key.current = crypto.randomUUID(); }
  }); };
  const action = (row, verb) => run(async current => {
    await personalRequest(`/uploads/${row.id}/${verb}`, { method: 'POST' });
    if (current()) setUploads((await personalRequest('/uploads')).uploads);
  });
  const cancelUpload = async row => {
    const version = generation.current;
    try {
      await personalRequest(`/uploads/${row.id}/cancel`, { method: 'POST' });
      if (transfer.current?.id === row.id) transfer.current.abort.abort();
      const data = await personalRequest('/uploads');
      if (version === generation.current) setUploads(data.uploads);
    } catch (cause) { if (version === generation.current) setError(cause.message); }
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="personal-overlay" /><Dialog.Content className="personal-dialog">
      <div className="personal-heading"><Dialog.Title>Google Earth Engine · My data</Dialog.Title><Dialog.Close aria-label="Close my data">×</Dialog.Close></div>
      <Dialog.Description>Connect your account, choose data for analysis, or import local data into your own Earth Engine assets.</Dialog.Description>
      {error || initialError ? <p role="alert">{error || initialError}</p> : null}
      {authorization === 'denied' ? <p role="alert">Google authorization was cancelled or denied. You can try again when ready.</p> : null}
      {authorization === 'failed' ? <p role="alert">Google sign-in could not be completed. Please try again.</p> : null}
      {authorization === 'connected' && account.user && account.connection?.readable ? <p role="status">Google sign-in and Earth Engine authorization are complete. Verify your project below to start using your data.</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="personal-scroll">
      {account.local ? <LocalConfiguration configuration={account.local} refresh={account.refresh} /> : null}
      {!loginAvailable ? <section><h3>Google account</h3><p role="status">{account.local ? 'Configure the application Desktop OAuth client above, then sign in with Google.' : account.ready ? 'Google sign-in is temporarily unavailable. Please try again later.' : 'Checking Google sign-in availability…'}</p>
          <button disabled>Sign in with Google and connect GEE</button><button onClick={() => run(() => account.refresh())} disabled={busy}>Retry</button></section>
        : !account.user ? <section><h3>Google account</h3><p>Sign in to connect your Earth Engine account with read-only access. Upload permission is requested only when you need it.</p><button onClick={() => authorize('login')}>Sign in with Google and connect GEE</button></section>
        : <>
        <section><h3>Connected identity</h3><p>{account.user.name || 'Google account'} · {account.user.email}</p>
          {!account.connection?.readable ? <p role="status">You are signed in to Google. Earth Engine read access has not been granted or the connection was disconnected. Connect Earth Engine to continue; your saved data is kept.</p> : null}
          <div className="personal-actions"><button disabled={busy} onClick={() => authorize('gee')}>{account.connection?.readable ? 'Renew Earth Engine connection' : 'Connect Earth Engine'}</button>
          <button disabled={busy} onClick={() => run(async () => { await personalRequest('/logout', { method: 'POST' }); await account.refresh(); })}>Sign out</button>
          <button disabled={busy || !account.connection?.active} onClick={() => run(async () => { await personalRequest('/disconnect', { method: 'POST' }); await account.refresh(); })}>Disconnect Earth Engine</button>
          <button disabled={busy || !account.connection?.active} onClick={() => run(async () => { await personalRequest('/disconnect?revoke=true', { method: 'POST' }); await account.refresh(); })}>Revoke Google access</button></div>
          <p>Google: signed in · Earth Engine: {account.connection?.readable ? 'authorized' : 'authorization needed'} · Project: {account.connection?.project || 'not verified'}</p>
        </section>
        <section><h3>Earth Engine project</h3><form onSubmit={event => { event.preventDefault(); run(async current => {
          await personalRequest('/connection', { method: 'PUT', body: { project, bucket } });
          if (current()) { await account.refresh(); setNotice('Project verified with a live Earth Engine request.'); }
        }); }}>
          <label>Cloud project ID<input value={project} onChange={event => setProject(event.target.value)} required placeholder="my-earth-engine-project" /></label>
          <label>Existing Cloud Storage bucket (needed only for uploads)<input value={bucket} onChange={event => setBucket(event.target.value)} placeholder="bucket-name, without gs://" /></label>
          <button disabled={busy || !account.connection?.readable}>Verify and save</button>
        </form></section>
        <section><h3>Browse assets</h3><div className="personal-inline"><input aria-label="Asset folder" value={parent} onChange={event => setParent(event.target.value)} placeholder={`projects/${account.connection?.project || 'project'}/assets`} />
          <button disabled={busy || !account.connection?.project} onClick={() => browse()}>Browse</button>
          <button disabled={busy || !account.connection?.project} onClick={() => browse('')}>Project root</button></div>
          <ul>{assets.map(row => <li key={row.name}><span>{row.name} · {row.type}</span><div>
            {['FOLDER', 'IMAGE_COLLECTION'].includes(row.type) ? <button disabled={busy} onClick={() => browse(row.name)}>Open</button> : null}
            {['IMAGE', 'IMAGE_COLLECTION', 'TABLE'].includes(row.type) ? <button disabled={busy} onClick={() => add(row.name)}>Verify data</button> : null}
          </div></li>)}</ul>
          {next ? <button disabled={busy} onClick={() => browse(parent, next)}>Load more</button> : null}
          <form onSubmit={event => { event.preventDefault(); add(asset); }} className="personal-inline"><input aria-label="Shared or legacy asset ID" value={asset} onChange={event => setAsset(event.target.value)} placeholder="projects/…/assets/… or users/…" required /><button disabled={busy}>Verify asset ID</button></form>
        </section>
        <section><h3>Data available for analysis</h3><p>Selection applies to the current intelligent-analysis conversation. Displaying a dataset does not change the AOI.</p>
          <div className="personal-inline"><label>Collection start<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label>Exclusive end<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label><label>Composite<select value={reducer} onChange={e => setReducer(e.target.value)}><option>median</option><option>mosaic</option></select></label></div>
          <ul>{account.datasets.map(row => <li key={row.id}><label><input type="checkbox" checked={account.selected.some(item => item.id === row.id)} disabled={!account.conversation || busy} onChange={() => account.toggle(row.id)} /><span>{row.name} · {row.type}<small>{row.asset_id}</small></span></label>
            <button disabled={busy || !account.conversation || !map.ready} onClick={() => show(row)}>Display in current extent</button></li>)}</ul>
          {!account.datasets.length ? <p>No verified datasets yet.</p> : null}
        </section>
        <section><h3>Upload to my Earth Engine</h3><p>GeoTIFF up to {Math.round((account.limits?.raster || 104857600) / 1048576)} MiB; GeoJSON up to {Math.round((account.limits?.vector || 10485760) / 1048576)} MiB. Files are staged in your configured bucket before import. Cloud Storage usage may incur charges.</p>
          {!account.connection?.uploadable ? <button disabled={busy} onClick={() => authorize('upload')}>Authorize uploads</button> : null}
          <form onSubmit={upload}><label>File<input type="file" accept=".tif,.tiff,.json,.geojson" onChange={event => { setFile(event.target.files[0] || null); key.current = crypto.randomUUID(); }} /></label>
            <label>Destination asset ID<input disabled={busy} value={destination} onChange={e => { setDestination(e.target.value); key.current = crypto.randomUUID(); }} placeholder={`projects/${account.connection?.project || 'project'}/assets/my-data`} required /></label>
            <p>Account: {account.user.email} · Project: {account.connection?.project || 'not set'} · Bucket: {account.connection?.bucket || 'not set'}</p>
            <button disabled={busy || !file || !account.connection?.uploadable || !account.connection?.project || !account.connection?.bucket}>{busy ? 'Working…' : 'Upload and import'}</button>
          </form>
          <ul>{uploads.map(row => <li key={row.id}><span>{row.filename} · <strong>{row.status}</strong><small>{row.asset_id}</small>{row.error ? <small>{row.error}</small> : null}</span>
            <div>{!terminal(row) ? <><button disabled={row.status === 'cancel_requested'} onClick={() => cancelUpload(row)}>Cancel upload</button>{row.error ? <button disabled={busy} onClick={() => action(row, 'resume')}>Resume</button> : null}</> : null}
              {row.status === 'failed' ? <button disabled={busy} onClick={() => action(row, 'retry')}>Retry</button> : null}
              {terminal(row) ? <button disabled={busy} onClick={() => action(row, 'cleanup')}>Clean staging files</button> : null}
              {row.status === 'ready' && row.data_ref && !account.selected.some(item => item.id === row.data_ref) ? <button disabled={busy || !account.conversation} onClick={() => account.toggle(row.data_ref)}>Use in analysis</button> : null}
            </div></li>)}</ul>
        </section>
        </>}
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
