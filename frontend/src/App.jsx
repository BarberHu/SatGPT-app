import React, { lazy, Profiler, Suspense, useEffect, useMemo } from 'react';
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
  logAgentDiagnostic,
  updateAgentDiagnosticsContext,
} from './utils/agentDiagnostics';
const AgentExperience = lazy(() => import('./components/AgentExperience'));

function App() {
  const { appMode, agentSidebarCollapsed } = useAppContext();
  const mapProfiler = useMemo(
    () => createReactProfilerHandler('MapContainer', () => ({ appMode })),
    [appMode]
  );
  const sidebarProfiler = useMemo(
    () => createReactProfilerHandler('AgentWorkspaceSidebar', () => ({
      appMode,
      agentSidebarCollapsed,
    })),
    [agentSidebarCollapsed, appMode]
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
  
  // Handle CopilotKit errors gracefully
  const handleCopilotError = (error) => {
    // Ignore abort errors (user cancelled operation)
    if (error?.message?.includes('aborted') || 
        error?.message?.includes('Aborted') ||
        error?.code === 'ABORT_ERR') {
      console.log('Operation cancelled by user');
      return;
    }
    // Log other errors
    console.error('CopilotKit error:', error);
    logAgentDiagnostic('copilot', 'runtime_error', {
      message: error?.message || 'unknown',
      code: error?.code || null,
      appMode,
    });
  };
  
  return (
    <div className={`water ${appMode === 'agent' ? 'water--agent' : ''} ${agentSidebarCollapsed ? 'water--agent-sidebar-collapsed' : ''}`}>
      <Profiler id="MapContainer" onRender={mapProfiler}>
        <MapContainer />
      </Profiler>
      <div className="ui">
        <SettingsButton />
        <Legends />
        <ModeBasedChatBox />
        <ModeBasedResultBox />
        {appMode === 'ask' ? <ControlPanel /> : null}
        <Warnings />
      </div>
      {appMode === 'agent' ? (
        <Suspense fallback={<div className="agent-runtime-loading" role="status">Loading Agent workspace…</div>}>
          <AgentExperience onError={handleCopilotError} sidebarProfiler={sidebarProfiler} />
        </Suspense>
      ) : null}
      <Modals />
      <Spinner />
    </div>
  );
}

function ModeBasedChatBox() {
  const { appMode } = useAppContext();

  if (appMode === 'agent') return null;

  return <ChatBox />;
}

// ResultBox only shown in Ask mode
function ModeBasedResultBox() {
  const { appMode } = useAppContext();
  
  // Hide ResultBox in Agent mode
  if (appMode === 'agent') return null;
  
  return <ResultBox />;
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
  const { warning } = useAppContext();
  
  if (!warning) return null;
  
  return (
    <div className="warnings" role="status" aria-live="polite">
      <span>{warning}</span>
    </div>
  );
}

export default App;
