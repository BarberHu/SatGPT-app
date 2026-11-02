import React, { lazy, Suspense, useState } from 'react';
import App from './App';
import { AppProvider } from './context/AppContext';

const HarnessApp = lazy(() => import('./harness/App'));
const MODE_STORAGE_KEY = 'satgpt:mode';

function initialMode() {
  try { return window.sessionStorage.getItem(MODE_STORAGE_KEY) === 'agent' ? 'agent' : 'basic'; }
  catch { return 'basic'; }
}

export default function ModeRoot() {
  const [mode, setMode] = useState(initialMode);
  const switchMode = (next) => {
    setMode(next);
    try { window.sessionStorage.setItem(MODE_STORAGE_KEY, next); }
    catch { /* The mode switch still works when storage is unavailable. */ }
  };

  if (mode === 'agent') {
    return (
      <Suspense fallback={<div role="status">正在加载 Harness Agent…</div>}>
        <HarnessApp onSwitchBasic={() => switchMode('basic')} />
      </Suspense>
    );
  }

  return (
    <AppProvider>
      <App onSwitchAgent={() => switchMode('agent')} />
    </AppProvider>
  );
}
