import React from 'react';
import { useAppContext } from '../context/AppContext';

export default function FloodImageryStatus() {
  const { agentAnalysisContext, agentFloodImageryLoading, agentImagery,
    agentShowFloodDetection } = useAppContext();
  if (!agentAnalysisContext?.user_confirmed) return null;
  const detection = agentImagery?.flood_detection;
  const error = detection?.error || agentImagery?.error;
  const message = agentFloodImageryLoading
    ? 'Satellite analysis is loading. The text report may finish first. You can switch panels while it loads.'
    : error
      ? `Flood detection is unavailable: ${error}`
      : detection?.tile_url
        ? (agentShowFloodDetection
          ? 'Flood detection is ready. Red pixels mark suspected inundation; the blue boundary is the analysis scope.'
          : 'Flood detection is ready. Open FLOOD and enable Flood Detection to view it.')
        : 'The event is confirmed. Satellite analysis is pending.';
  return <div className="agent-workspace-sidebar__imagery-status" role="status" aria-live="polite">{message}</div>;
}
