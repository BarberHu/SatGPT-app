import React, { lazy, Suspense, useState } from 'react';
import App from './App';
import { AppProvider } from './context/AppContext';
import WorkspaceHeader from './components/WorkspaceHeader';
import { SharedMapProvider, SharedMapSurface, useSharedMap } from './map/SharedMapContext';
import './styles/theme.css';
import './styles/workspace.css';

const HarnessApp = lazy(() => import('./harness/App'));
const MODE_STORAGE_KEY = 'satgpt:mode';
function initialMode() {
  try { return window.sessionStorage.getItem(MODE_STORAGE_KEY) === 'agent' ? 'agent' : 'basic'; }
  catch { return 'basic'; }
}
function Workspace({ mode, changeMode, agentVisited }) {
  const map = useSharedMap();
  const [historyTools, setHistoryTools] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const canCapture = map.ready && map.visible;
  const capture = async () => {
    if (!canCapture || capturing) return;
    setCapturing(true); setCaptureError('');
    try { await map.snapshot(); }
    catch { setCaptureError('Map capture failed. Please try again.'); }
    finally { setCapturing(false); }
  };
  return <div className="satgpt-root" data-mode={mode}>
    <WorkspaceHeader mode={mode} onModeChange={changeMode} canCapture={canCapture} capturing={capturing} onCapture={capture}
      captureHint="Show the map workspace to capture an image" historyTools={mode === 'agent' ? historyTools : null} />
    {captureError ? <div className="satgpt-capture-error" role="alert">{captureError}</div> : null}
    <main className="satgpt-mode-content">
      <SharedMapSurface />
      <div className="satgpt-business-panel satgpt-basic-panel" hidden={mode !== 'basic'} role="tabpanel" id="satgpt-panel-basic" aria-labelledby="satgpt-tab-basic">
        <App active={mode === 'basic'} />
      </div>
      {agentVisited ? <div className="satgpt-business-panel satgpt-agent-panel" hidden={mode !== 'agent'} role="tabpanel" id="satgpt-panel-agent" aria-labelledby="satgpt-tab-agent">
        <Suspense fallback={<div className="satgpt-mode-loading" role="status">Loading intelligent analysis…</div>}>
          <HarnessApp active={mode === 'agent'} onHistoryToolsChange={setHistoryTools} />
        </Suspense>
      </div> : null}
    </main>
  </div>;
}
export default function ModeRoot() {
  const [mode, setMode] = useState(initialMode);
  const [agentVisited, setAgentVisited] = useState(mode === 'agent');
  const changeMode = next => {
    if (next === mode) return;
    if (next === 'agent') setAgentVisited(true);
    setMode(next);
    try { sessionStorage.setItem(MODE_STORAGE_KEY, next); } catch { /* Optional storage. */ }
  };
  return <AppProvider><SharedMapProvider mode={mode}>
    <Workspace mode={mode} changeMode={changeMode} agentVisited={agentVisited} />
  </SharedMapProvider></AppProvider>;
}
