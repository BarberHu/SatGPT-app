import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AOI_NOTICE_KEY, aoiRepository } from './repository.js';

const unavailable = { records: [], ready: false, error: 'Local area storage is unavailable.', reload: async () => {} };
const Context = createContext(unavailable);
export const useAoiLibrary = () => useContext(Context);

export function AoiLibraryProvider({ children, repository = aoiRepository }) {
  const [records, setRecords] = useState([]), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [migrationError, setMigrationError] = useState('');
  const alive = useRef(false), version = useRef(0);
  const reload = useCallback(async () => {
    const epoch = ++version.current;
    try {
      const rows = await repository.list();
      if (alive.current && epoch === version.current) { setRecords(rows); setReady(true); setError(''); }
      return true;
    } catch { if (alive.current && epoch === version.current) { setReady(false); setError('Unable to read saved areas. Existing data has been kept. Retry to continue.'); } return false; }
  }, [repository]);
  useEffect(() => {
    alive.current = true;
    (async () => {
      if (!await reload()) return;
      try {
        const result = await repository.migrate();
        await reload();
        if (alive.current) setMigrationError(result.invalid ? `${result.invalid} legacy area(s) could not be imported. Original data has been kept.` : '');
      } catch { if (alive.current) setMigrationError('Area migration could not finish. Original data has been kept. Retry migration.'); }
    })();
    const changed = event => { if (event.key === AOI_NOTICE_KEY) reload(); };
    window.addEventListener('storage', changed);
    return () => { alive.current = false; version.current++; window.removeEventListener('storage', changed); };
  }, [repository, reload]);
  const mutate = async (method, ...args) => {
    if (!ready) throw new Error('Saved areas have not loaded. Retry before saving.');
    const result = await repository[method](...args); await reload(); return result;
  };
  const retry = async () => {
    if (!await reload()) throw new Error('Saved areas could not be read. Original data has been kept.');
    try {
      const result = await repository.migrate(); await reload();
      if (alive.current) setMigrationError(result.invalid ? `${result.invalid} legacy area(s) could not be imported. Original data has been kept.` : '');
    } catch (cause) { if (alive.current) setMigrationError('Area migration could not finish. Original data has been kept. Retry migration.'); throw cause; }
  };
  return <Context.Provider value={{ records, ready, error: error || migrationError, reload, retry,
    save: (...args) => mutate('save', ...args), remove: record => mutate('remove', record), restore: record => mutate('restore', record) }}>{children}</Context.Provider>;
}
