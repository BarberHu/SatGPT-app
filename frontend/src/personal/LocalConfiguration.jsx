import React, { useState } from 'react';
import { localRequest } from './api';

export default function LocalConfiguration({ configuration, refresh }) {
  const [provider, setProvider] = useState(configuration.provider);
  const [model, setModel] = useState(configuration.model);
  const [base, setBase] = useState(configuration.base_url);
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [history, setHistory] = useState([]), [record, setRecord] = useState(null);
  const run = async (action, success = 'Saved on this computer.') => {
    setBusy(true); setMessage('');
    try { await action(); await refresh(); setMessage(success); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  return <section><h3>Local application</h3>
    <p>Agent, conversation history, previews and file staging run on this computer. Credentials are protected for this Windows user. Basic cloud services are unavailable in this mode.</p>
    <p>GEE computation and imported assets use your Google cloud resources. Questions, analysis context and tool results are sent directly to your selected model service.</p>
    <details open={!configuration.oauth_configured || !configuration.model_configured}>
      <summary>Application and model setup</summary>
      <p>Google application: {configuration.oauth_configured ? 'Desktop OAuth client configured' : 'not configured'}. This is application setup; Google login below connects your personal account.</p>
      <label>Import application Desktop OAuth JSON<input type="file" accept=".json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) run(async () => {
          if (file.size > 16384) throw new Error('Choose the small OAuth client JSON downloaded from Google Cloud.');
          let document;
          try { document = JSON.parse(await file.text()); }
          catch { throw new Error('Choose a valid Desktop OAuth JSON file downloaded from Google Cloud.'); }
          await localRequest('/oauth', document);
        });
      }} /></label>
      <form onSubmit={event => { event.preventDefault(); run(async () => {
        await localRequest('/model', { provider, model, api_key: key, base_url: base }); setKey('');
      }); }}>
        <label>Model provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="deepseek-official">DeepSeek</option><option value="aihubmix">AIHubMix</option></select></label>
        <label>Model name<input value={model} onChange={event => setModel(event.target.value)} required /></label>
        {provider === 'aihubmix' ? <label>Model service URL<input type="url" value={base} onChange={event => setBase(event.target.value)} required /></label> : null}
        <label>Model API key<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={configuration.model_configured ? 'Saved locally; leave blank to keep' : 'Your model API key'} /></label>
        <button disabled={busy}>Save local model configuration</button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </details>
    <details><summary>Previous system history · read only</summary>
      <p>Previous system analyses remain readable. Start a new analysis with your Google account to generate new results; historical layers are never replayed under a different identity.</p>
      <button disabled={busy} onClick={() => run(async () => setHistory((await localRequest('/history')).conversations), 'Previous history loaded; original data is preserved.')}>Browse previous history</button>
      <ul>{history.map(item => <li key={item.id}><button disabled={busy} onClick={() => run(async () => setRecord(await localRequest(`/history/${encodeURIComponent(item.id)}`)), 'Read-only history loaded.')}>{item.title || item.id}</button></li>)}</ul>
      {record ? <div aria-label="Read-only historical conversation">{record.messages.map((item, index) => <div key={item.id || index}><strong>{item.role}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{item.content}</p>{item.code ? <pre>{item.code}</pre> : null}</div>)}</div> : null}
    </details>
  </section>;
}
