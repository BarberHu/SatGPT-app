import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { personalRequest, setPersonalCsrf } from './api';
import PersonalDialog from './PersonalDialog';

const defaults = { ready: true, enabled: false, user: null, connection: null, workspaceKey: 'system',
  selected: [], datasets: [], open: () => {}, setConversation: () => {}, remove: () => {} };
const Context = createContext(defaults);
export const usePersonal = () => useContext(Context);

export function PersonalProvider({ children }) {
  const [status, setStatus] = useState({ ...defaults, ready: false });
  const [opened, setOpened] = useState(false), [error, setError] = useState('');
  const [authorization, setAuthorization] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('google');
    return ['connected', 'denied', 'failed'].includes(value) ? value : null;
  });
  const [datasets, setDatasets] = useState([]), [selections, setSelections] = useState({});
  const [conversation, setConversation] = useState(null), [displayVersion, setDisplayVersion] = useState(0);
  const epoch = useRef(0), identity = useRef(null);
  useEffect(() => {
    if (!authorization) return;
    setOpened(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('google');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [authorization]);
  const refresh = useCallback(async () => {
    const version = ++epoch.current;
    try {
      const data = await personalRequest('/status');
      if (version !== epoch.current) return;
      const key = `${data.user?.owner || 'system'}:${data.connection?.revision || 0}:${Boolean(data.connection?.active)}:${Boolean(data.connection?.readable)}`;
      setPersonalCsrf(data.csrf, data.user?.owner || 'system');
      if (identity.current !== key) { setDatasets([]); setSelections({}); setConversation(null); identity.current = key; }
      setStatus({ ...data, ready: true, workspaceKey: key }); setError('');
    } catch (cause) {
      if (version === epoch.current) setError(cause.message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const focus = () => refresh(); window.addEventListener('focus', focus);
    window.addEventListener('satgpt-account-changed', focus);
    return () => { ++epoch.current; window.removeEventListener('focus', focus); window.removeEventListener('satgpt-account-changed', focus); setPersonalCsrf(''); };
  }, [refresh]);
  const loadDatasets = useCallback(async () => {
    const version = epoch.current;
    const data = await personalRequest('/datasets');
    if (version === epoch.current) setDatasets(data.datasets);
  }, []);
  const selected = (selections[conversation] || []).map(id => datasets.find(row => row.id === id)).filter(Boolean);
  const toggle = id => setSelections(previous => {
    if (!conversation) return previous;
    const before = previous[conversation] || [];
    return { ...previous, [conversation]: before.includes(id) ? before.filter(value => value !== id) : [...before, id].slice(0, 20) };
  });
  const value = { ...status, selected, datasets, conversation, refresh, loadDatasets, toggle,
    remove: id => setSelections(previous => ({ ...previous, [conversation]: (previous[conversation] || []).filter(value => value !== id) })),
    setConversation, open: () => setOpened(true), displayVersion,
    displayed: () => setDisplayVersion(v => v + 1) };
  return <Context.Provider value={value}>{children}
    <PersonalDialog open={opened} onOpenChange={next => { setOpened(next); if (!next) setAuthorization(null); }}
      error={error} authorization={authorization} />
  </Context.Provider>;
}
