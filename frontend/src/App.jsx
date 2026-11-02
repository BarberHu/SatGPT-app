import React, { Profiler, useEffect, useMemo } from 'react';
import MapContainer from './components/MapContainer';
import ControlPanel from './components/ControlPanel';
import ChatBox from './components/ChatBox';
import ResultBox from './components/ResultBox';
import Legends from './components/Legends';
import Modals from './components/Modals';
import Spinner from './components/Spinner';
import { useAppContext } from './context/AppContext';
import useMapData from './hooks/useMapData';
import {
  createReactProfilerHandler,
  installLongTaskObserver,
  updateAgentDiagnosticsContext,
} from './utils/agentDiagnostics';
function App({ active = true }) {
  const { appMode, agentSidebarCollapsed, resultText } = useAppContext();
  const mapProfiler = useMemo(
    () => createReactProfilerHandler('MapContainer', () => ({ appMode })),
    [appMode]
  );

  // Initialize map data loading hook
  useMapData();

  useEffect(() => installLongTaskObserver(), []);

  useEffect(() => {
    updateAgentDiagnosticsContext({
      appMode,
      agentSidebarCollapsed,
    });
  }, [agentSidebarCollapsed, appMode]);
  
  return (
    <div className="water">
      <Profiler id="MapContainer" onRender={mapProfiler}>
        <MapContainer active={active} />
      </Profiler>
      <SettingsButton />
      <div className="ui">
        <Legends />
        <ControlPanel />
        <Warnings />
      </div>
      <div className="ask-dock">
        <ResultBox />
        <div className="ask-dock-composer" hidden={Boolean(resultText)}>
          <ChatBox />
        </div>
      </div>
      <Modals active={active} />
      <Spinner />
    </div>
  );
}

function SettingsButton() {
  const { isPanelVisible, setIsPanelVisible } = useAppContext();
  
  if (isPanelVisible) return null;
  
  return (
    <button
      type="button"
      className="settings-button" 
      onClick={() => setIsPanelVisible(true)}
      aria-label="Open control panel"
      title="Open control panel"
    >
      &#9776;
    </button>
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
