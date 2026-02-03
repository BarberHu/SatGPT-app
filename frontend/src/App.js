import React from 'react';
import MapContainer from './components/MapContainer';
import ControlPanel from './components/ControlPanel';
import ChatBox from './components/ChatBox';
import ResultBox from './components/ResultBox';
import Legends from './components/Legends';
import Modals from './components/Modals';
import Spinner from './components/Spinner';
import { useAppContext } from './context/AppContext';
import useMapData from './hooks/useMapData';

function App() {
  // Initialize map data loading hook
  useMapData();
  
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
