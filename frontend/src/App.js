import React, { Profiler, useEffect, useMemo } from 'react';
import { CopilotKit } from "@copilotkit/react-core";
import MapContainer from './components/MapContainer';
import ControlPanel from './components/ControlPanel';
import ChatBox from './components/ChatBox';
import ResultBox from './components/ResultBox';
import Legends from './components/Legends';
import Modals from './components/Modals';
import Spinner from './components/Spinner';
import AgentWorkspaceSidebar from './components/AgentWorkspaceSidebar';
import LocationScopePicker from './components/LocationScopePicker';
import { useAppContext } from './context/AppContext';
import useMapData from './hooks/useMapData';
import {
  createReactProfilerHandler,
  installLongTaskObserver,
  logAgentDiagnostic,
  updateAgentDiagnosticsContext,
} from './utils/agentDiagnostics';
import { resolveBrowserEndpoint } from './utils/runtimeUrls';

// CopilotKit 运行时地址，支持本机与局域网访问时自动纠正。
const COPILOTKIT_URL = resolveBrowserEndpoint(
  process.env.REACT_APP_COPILOTKIT_URL,
  '/copilotkit'
);

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
    <CopilotKit 
      runtimeUrl={COPILOTKIT_URL} 
      agent="flood_agent"
      onError={handleCopilotError}
    >
      <div className={`water ${appMode === 'agent' ? 'water--agent' : ''} ${agentSidebarCollapsed ? 'water--agent-sidebar-collapsed' : ''}`}>
        <Profiler id="MapContainer" onRender={mapProfiler}>
          <MapContainer />
        </Profiler>
        <div className="ui">
          <SettingsButton />
          <Legends />
          <ModeBasedChatBox />
          <ModeBasedResultBox />
          <ControlPanel />
          <Warnings />
        </div>
        <Profiler id="AgentWorkspaceSidebar" onRender={sidebarProfiler}>
          <AgentWorkspaceSidebar />
        </Profiler>
        <AgentLocationSearchDock />
        <Modals />
        <Spinner />
      </div>
    </CopilotKit>
  );
}

function AgentLocationSearchDock() {
  const { appMode } = useAppContext();

  if (appMode !== 'agent') return null;

  return (
    <div className="agent-location-search-dock">
      <LocationScopePicker embedded showInlineNote={false} />
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
    <div 
      className="settings-button" 
      onClick={() => setIsPanelVisible(true)}
    >
      &#9776;
    </div>
  );
}

function Warnings() {
  const { warning } = useAppContext();
  
  if (!warning) return null;
  
  return (
    <div className="warnings">
      <span>{warning}</span>
    </div>
  );
}

export default App;
