import React, { useState, useEffect } from 'react';
import { CopilotKit } from "@copilotkit/react-core";
import MapContainer from './components/MapContainer';
import ControlPanel from './components/ControlPanel';
import ChatBox from './components/ChatBox';
import ResultBox from './components/ResultBox';
import Legends from './components/Legends';
import Modals from './components/Modals';
import Spinner from './components/Spinner';
import { useAppContext } from './context/AppContext';
import useMapData from './hooks/useMapData';

// CopilotKit 运行时地址
const COPILOTKIT_URL = process.env.REACT_APP_COPILOTKIT_URL || "http://localhost:5000/copilotkit";

// 检查 CopilotKit Runtime 是否可用
function useCopilotKitAvailable() {
  const [available, setAvailable] = useState(false);
  const [checked, setChecked] = useState(false);
  
  useEffect(() => {
    // 使用 /health 端点检查 Runtime 是否可用
    fetch('http://localhost:5000/health', { method: 'GET' })
      .then(res => {
        setAvailable(res.ok);
        setChecked(true);
      })
      .catch(() => {
        setAvailable(false);
        setChecked(true);
      });
  }, []);
  
  return { available, checked };
}

function App() {
  // Initialize map data loading hook
  useMapData();
  const { available: copilotAvailable, checked } = useCopilotKitAvailable();
  
  // 等待检查完成
  if (!checked) {
    return <div className="water"><Spinner /></div>;
  }
  
  // 如果 CopilotKit 不可用，使用传统模式
  if (!copilotAvailable) {
    return (
      <div className="water">
        <MapContainer />
        <div className="ui">
          <SettingsButton />
          <Legends />
          <ChatBox />
          <ResultBox />
          <ControlPanel />
          <Warnings />
        </div>
        <Modals />
        <Spinner />
      </div>
    );
  }
  
  // CopilotKit available - use full functionality
  // ChatBox is always shown (handles mode switching internally)
  
  // Handle CopilotKit errors gracefully
  const handleCopilotError = (error) => {
    // Ignore abort errors (user cancelled operation)
    if (error?.message?.includes('aborted') || 
        error?.message?.includes('Aborted') ||
        error?.code === 'ABORT_ERR') {
      console.log('ℹ️ Operation cancelled by user');
      return;
    }
    // Log other errors
    console.error('CopilotKit error:', error);
  };
  
  return (
    <CopilotKit 
      runtimeUrl={COPILOTKIT_URL} 
      agent="flood_agent"
      onError={handleCopilotError}
    >
      <div className="water">
        <MapContainer />
        <div className="ui">
          <SettingsButton />
          <Legends />
          <ChatBox />
          <ModeBasedResultBox />
          <ControlPanel />
          <Warnings />
        </div>
        <Modals />
        <Spinner />
      </div>
    </CopilotKit>
  );
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
