import React, { Profiler, useEffect, useMemo, useState } from 'react';
import MapContainer from './components/MapContainer';
import BasicLayerWorkspace from './presets/BasicLayerWorkspace';
import ChatBox from './components/ChatBox';
import ResultBox from './components/ResultBox';
import Spinner from './components/Spinner';
import { useAppContext } from './context/AppContext';
import {
  createReactProfilerHandler,
  installLongTaskObserver,
  updateAgentDiagnosticsContext,
} from './utils/agentDiagnostics';
function App({ active = true }) {
  const { resultText } = useAppContext();
  const [chatOpen, setChatOpen] = useState(false);
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
      <BasicLayerWorkspace active={active} />
      <div className="ui">
        <Warnings />
      </div>
      <div className={`ask-dock preset-ask-dock${chatOpen ? ' is-open' : ''}`}>
        <button className="preset-chat-toggle" type="button" aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}>Basic questions {chatOpen ? '−' : '+'}</button>
        <div hidden={!chatOpen}><ResultBox /><div className="ask-dock-composer" hidden={Boolean(resultText)}><ChatBox /></div></div>
      </div>
      <Spinner />
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
