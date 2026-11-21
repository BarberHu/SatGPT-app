import React, { Profiler, useEffect, useMemo } from 'react';
import MapContainer from './components/MapContainer';
import BasicLayerWorkspace from './presets/BasicLayerWorkspace';
import { useAppContext } from './context/AppContext';
import {
  createReactProfilerHandler,
  installLongTaskObserver,
  updateAgentDiagnosticsContext,
} from './utils/agentDiagnostics';

function App({ active = true }) {
  const mapProfiler = useMemo(
    () => createReactProfilerHandler('MapContainer', () => ({ mode: 'basic' })),
    []
  );

  useEffect(() => installLongTaskObserver(), []);

  useEffect(() => { updateAgentDiagnosticsContext({ mode: 'basic' }); }, []);
  
  return (
    <div className="water">
      <Profiler id="MapContainer" onRender={mapProfiler}>
        <MapContainer active={active} />
      </Profiler>
      <BasicLayerWorkspace />
      <div className="ui">
        <Warnings />
      </div>
    </div>
  );
}

function Warnings() {
  const { warning, setWarning } = useAppContext();

  if (!warning) return null;

  return (
    <div className="warnings" role="status" aria-live="polite">
      <span>{warning}</span>
      <button
        type="button"
        className="warnings__close"
        onClick={() => setWarning('')}
        aria-label="Dismiss warning"
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}

export default App;
