/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useCoAgent, useLangGraphInterrupt, useCopilotMessagesContext } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import SourcesDrawer from './SourcesDrawer';
import './AgentPanel.css';

// FloodAgent 默认状态
const defaultAgentState = {
  event: null,
  event_description: null,
  flood_report: null,
  report_document: null,
  pre_date: null,
  after_date: null,
  peek_date: null,
  location: null,
  coordinates: null,
  bounds: null,
  geojson: null,
  search_sources: null,
  is_valid_flood_query: false,
};

// Download report as Markdown file
function downloadReport(report, eventName) {
  const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${eventName || 'flood_analysis_report'}_${new Date().toISOString().split('T')[0]}.md`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AgentPanel() {
  const { 
    setFloodAgentState, 
    floodAgentState,
    setAgentImagery,
    setAgentImageryLoading,
    agentImagery,
    agentImageryLoading,
    mapInstance,
    // Agent control states from context
    agentSelectedPeriod,
    setAgentSelectedPeriod,
    agentSelectedType,
    setAgentSelectedType,
    agentShowFloodDetection,
    setAgentShowFloodDetection,
    agentShowPopulationLayer,
    setAgentShowPopulationLayer,
    agentShowUrbanLayer,
    setAgentShowUrbanLayer,
    agentShowLandcoverLayer,
    setAgentShowLandcoverLayer,
    agentImpactData,
    setAgentImpactData,
    agentImpactLoading,
    setAgentImpactLoading,
  } = useAppContext();
  
  // Get chat messages from CopilotKit (with safety check)
  const messagesContext = useCopilotMessagesContext();
  const messages = messagesContext?.messages || [];
  
  // Local UI state (for section expansion only)
  const [sourcesDrawerOpen, setSourcesDrawerOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    event: true,
    dates: true,
    imagery: false,
    layers: false,
    impact: true,
    chatHistory: true,
  });

  // Use CopilotKit's useCoAgent for state sync
  const { state, setState } = useCoAgent({
    name: "flood_agent",
    initialState: defaultAgentState,
  });

  // Sync agent state to AppContext when it changes
  useEffect(() => {
    if (state) {
      setFloodAgentState(state);
      
      // Move map to coordinates if available
      if (state.coordinates && mapInstance) {
        const [lng, lat] = state.coordinates;
        if (lng !== 0 && lat !== 0) {
          mapInstance.flyTo({
            center: [lng, lat],
            zoom: 8,
            duration: 2000,
          });
        }
      }
      
      // Add GeoJSON to map if available
      if (state.geojson && mapInstance) {
        addGeoJSONToMap(state.geojson);
      }
      
      // Fetch imagery when we have complete data
      if (state.pre_date && state.peek_date && state.after_date && 
          (state.bounds || state.geojson)) {
        fetchAgentImagery(state);
      }
    }
  }, [state, mapInstance, setFloodAgentState]);

  // Add GeoJSON to map
  const addGeoJSONToMap = useCallback((geojson) => {
    if (!mapInstance) return;
    
    const sourceId = 'agent-geojson';
    const layerId = 'agent-geojson-layer';
    const outlineLayerId = 'agent-geojson-outline';
    
    // Remove existing layers and source
    if (mapInstance.getLayer(outlineLayerId)) {
      mapInstance.removeLayer(outlineLayerId);
    }
    if (mapInstance.getLayer(layerId)) {
      mapInstance.removeLayer(layerId);
    }
    if (mapInstance.getSource(sourceId)) {
      mapInstance.removeSource(sourceId);
    }
    
    // Add new source and layers
    mapInstance.addSource(sourceId, {
      type: 'geojson',
      data: geojson,
    });
    
    mapInstance.addLayer({
      id: layerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': 0.1,
      },
    });
    
    mapInstance.addLayer({
      id: outlineLayerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#3b82f6',
        'line-width': 2,
      },
    });
  }, [mapInstance]);

  // Fetch FloodAgent imagery
  const fetchAgentImagery = useCallback(async (agentState) => {
    setAgentImageryLoading(true);
    try {
      const response = await fetch('http://localhost:8000/api/flood-images', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pre_date: agentState.pre_date,
          peek_date: agentState.peek_date,
          after_date: agentState.after_date,
          longitude: agentState.coordinates?.[0] || 0,
          latitude: agentState.coordinates?.[1] || 0,
          bounds: agentState.bounds,
          geojson: agentState.geojson?.geometry,
        }),
      });
      
      const result = await response.json();
      if (result.success) {
        setAgentImagery(result.data);
      }
    } catch (error) {
      console.error('Failed to fetch imagery:', error);
    } finally {
      setAgentImageryLoading(false);
    }
  }, [setAgentImagery, setAgentImageryLoading]);

  // Fetch flood impact assessment data
  const fetchImpactData = useCallback(async () => {
    const currentState = state || floodAgentState;
    if (!currentState.pre_date || !currentState.peek_date) return;
    if (agentImpactData) return; // Already loaded
    
    setAgentImpactLoading(true);
    try {
      const response = await fetch('http://localhost:8000/api/flood-impact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pre_date: currentState.pre_date,
          peek_date: currentState.peek_date,
          bounds: currentState.bounds,
          geojson: currentState.geojson,
        }),
      });
      
      const result = await response.json();
      if (result.success) {
        setAgentImpactData(result.data);
      }
    } catch (error) {
      console.error('Failed to fetch impact data:', error);
    } finally {
      setAgentImpactLoading(false);
    }
  }, [state, floodAgentState, agentImpactData, setAgentImpactData, setAgentImpactLoading]);

  // Load impact data when user enables impact layers
  useEffect(() => {
    if ((agentShowPopulationLayer || agentShowUrbanLayer || agentShowLandcoverLayer) && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentShowPopulationLayer, agentShowUrbanLayer, agentShowLandcoverLayer, agentImpactData, agentImpactLoading, fetchImpactData]);

  // Human-in-the-Loop: Handle LangGraph interrupt events
  useLangGraphInterrupt({
    enabled: ({ eventValue }) => eventValue?.type === "confirm_flood_event",
    render: ({ event, resolve }) => {
      const interruptData = event.value;

      return (
        <EventConfirmation
          data={interruptData.data}
          message={interruptData.message}
          onConfirm={(confirmedData) => {
            resolve(JSON.stringify(confirmedData));
          }}
          onCancel={() => {
            resolve(JSON.stringify({ cancelled: true }));
          }}
        />
      );
    },
  });

  const currentState = state || floodAgentState;
  const hasValidDates = currentState.pre_date && currentState.peek_date && currentState.after_date;

  // Toggle section expansion
  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Date periods for display
  const periods = [
    { key: 'pre_date', label: 'Pre-Flood', date: currentState.pre_date },
    { key: 'peek_date', label: 'Peak', date: currentState.peek_date },
    { key: 'after_date', label: 'Post-Flood', date: currentState.after_date },
  ];

  return (
    <div className="agent-panel-controls">
      {/* Sources Drawer */}
      <SourcesDrawer
        sources={currentState.search_sources || []}
        isOpen={sourcesDrawerOpen}
        onClose={() => setSourcesDrawerOpen(false)}
      />

      {/* Event Info Section */}
      <div className={`control-section ${expandedSections.event ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('event')}>
          <span className="section-icon">📍</span>
          <span className="section-title">Event Info</span>
          <span className={`expand-icon ${expandedSections.event ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.event && (
          <div className="section-body">
            {currentState.event ? (
              <>
                <div className="info-row">
                  <span className="info-label">Event:</span>
                  <span className="info-value">{currentState.event}</span>
                </div>
                {currentState.location && (
                  <div className="info-row">
                    <span className="info-label">Location:</span>
                    <span className="info-value">{currentState.location}</span>
                  </div>
                )}
                {currentState.event_description && (
                  <div className="info-row description">
                    <span className="info-value">{currentState.event_description}</span>
                  </div>
                )}
                <div className="action-buttons">
                  {currentState.search_sources?.length > 0 && (
                    <button 
                      className="action-btn"
                      onClick={() => setSourcesDrawerOpen(true)}
                    >
                      🌐 Sources ({currentState.search_sources.length})
                    </button>
                  )}
                  {currentState.flood_report && (
                    <button 
                      className="action-btn primary"
                      onClick={() => downloadReport(currentState.flood_report, currentState.event)}
                    >
                      📥 Download Report
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="no-data-hint">
                <span>💬 Ask about a flood event in the chat below</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Impact Assessment Section */}
      <div className={`control-section ${expandedSections.impact ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('impact')}>
          <span className="section-icon">📊</span>
          <span className="section-title">Impact Assessment</span>
          <span className={`expand-icon ${expandedSections.impact ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.impact && (
          <div className="section-body">
            {agentImpactLoading ? (
              <div className="loading-indicator">
                <span className="spinner">⏳</span> Calculating impact assessment...
              </div>
            ) : agentImpactData ? (
              <div className="impact-stats">
                <div className="impact-stat-item">
                  <span className="impact-icon">🌊</span>
                  <span className="impact-label">Flooded Area</span>
                  <span className="impact-value">
                    {agentImagery?.flood_detection?.stats?.flood_area_km2 || agentImpactData.flood_area?.value?.toFixed(2) || 0} km²
                  </span>
                </div>
                <div className="impact-stat-item">
                  <span className="impact-icon">👥</span>
                  <span className="impact-label">Affected Population</span>
                  <span className="impact-value">
                    {(agentImpactData.population?.affected || 0).toLocaleString()}
                  </span>
                </div>
                <div className="impact-stat-item">
                  <span className="impact-icon">🏙️</span>
                  <span className="impact-label">Built-up Flooded</span>
                  <span className="impact-value">
                    {agentImpactData.urban?.affected_area_km2?.toFixed(2) || 0} km²
                  </span>
                </div>
                <div className="impact-source">
                  Data: WorldPop · ESA WorldCover · GHSL
                </div>
              </div>
            ) : (
              <div className="no-impact-data">
                <p>Enable analysis layers to calculate impact</p>
                <button 
                  className="load-impact-btn"
                  onClick={fetchImpactData}
                  disabled={!state?.pre_date || !state?.peek_date}
                >
                  Calculate Now
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Date Selection Section */}
      <div className={`control-section ${expandedSections.dates ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('dates')}>
          <span className="section-icon">📅</span>
          <span className="section-title">Date Selection</span>
          <span className={`expand-icon ${expandedSections.dates ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.dates && (
          <div className="section-body">
            {hasValidDates ? (
              <div className="date-timeline">
                {periods.map((p, i) => (
                  <div key={p.key} className="timeline-item">
                    <button
                      className={`date-btn ${agentSelectedPeriod === p.key ? 'active' : ''}`}
                      onClick={() => setAgentSelectedPeriod(p.key)}
                    >
                      <span className="period-label">{p.label}</span>
                      <span className="period-date">{p.date || '-'}</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-data-hint">
                <span>Dates will appear after analyzing an event</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Imagery Type Section */}
      <div className={`control-section ${expandedSections.imagery ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('imagery')}>
          <span className="section-icon">🛰️</span>
          <span className="section-title">Imagery Type</span>
          <span className={`expand-icon ${expandedSections.imagery ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.imagery && (
          <div className="section-body">
            <div className="imagery-type-buttons">
              <button
                className={`type-btn ${agentSelectedType === 'sentinel2' ? 'active' : ''}`}
                onClick={() => setAgentSelectedType('sentinel2')}
              >
                🌍 Optical (S2)
              </button>
              <button
                className={`type-btn ${agentSelectedType === 'sentinel1' ? 'active' : ''}`}
                onClick={() => setAgentSelectedType('sentinel1')}
              >
                📡 SAR Radar (S1)
              </button>
            </div>
            
            {agentImageryLoading && (
              <div className="loading-indicator">
                <span className="spinner">⏳</span> Loading imagery...
              </div>
            )}
          </div>
        )}
      </div>

      {/* Analysis Layers Section */}
      <div className={`control-section ${expandedSections.layers ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('layers')}>
          <span className="section-icon">🗺️</span>
          <span className="section-title">Analysis Layers</span>
          <span className={`expand-icon ${expandedSections.layers ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.layers && (
          <div className="section-body">
            <div className="layer-toggles">
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={agentShowFloodDetection}
                  onChange={() => setAgentShowFloodDetection(!agentShowFloodDetection)}
                />
                <span className="layer-icon">🌊</span>
                <span>Flood Detection</span>
              </label>
              
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={agentShowPopulationLayer}
                  onChange={() => setAgentShowPopulationLayer(!agentShowPopulationLayer)}
                />
                <span className="layer-icon">👥</span>
                <span>Population Impact</span>
              </label>
              
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={agentShowUrbanLayer}
                  onChange={() => setAgentShowUrbanLayer(!agentShowUrbanLayer)}
                />
                <span className="layer-icon">🏙️</span>
                <span>Built-up Area</span>
              </label>
              
              <label className="layer-toggle">
                <input
                  type="checkbox"
                  checked={agentShowLandcoverLayer}
                  onChange={() => setAgentShowLandcoverLayer(!agentShowLandcoverLayer)}
                />
                <span className="layer-icon">🌳</span>
                <span>Land Cover</span>
              </label>
            </div>
            
            {/* Layer Legend */}
            <div className="layer-legend">
              <h5>Legend</h5>
              <div className="legend-items">
                {agentShowFloodDetection && (
                  <div className="legend-item">
                    <span className="legend-color" style={{ background: '#ff4444' }}></span>
                    <span>Flooded Area</span>
                  </div>
                )}
                {agentShowPopulationLayer && (
                  <div className="legend-item">
                    <span className="legend-gradient population"></span>
                    <span>Population Density</span>
                  </div>
                )}
                {agentShowUrbanLayer && (
                  <div className="legend-item">
                    <span className="legend-color" style={{ background: '#ff6600' }}></span>
                    <span>Built-up</span>
                  </div>
                )}
                {agentShowLandcoverLayer && (
                  <div className="legend-row">
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#006400' }}></span>
                      <span>Forest</span>
                    </div>
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#ffbb22' }}></span>
                      <span>Crop</span>
                    </div>
                    <div className="legend-item-small">
                      <span className="legend-dot" style={{ background: '#0064c8' }}></span>
                      <span>Water</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chat History Section */}
      <div className="control-section">
        <div className="section-header" onClick={() => toggleSection('chatHistory')}>
          <span className="section-icon">💬</span>
          <span className="section-title">Chat History</span>
          <span className={`expand-icon ${expandedSections.chatHistory ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.chatHistory && (
          <div className="section-body chat-history-section">
            {messages && messages.length > 0 ? (
              <div className="chat-history-list">
                {messages.map((msg, index) => (
                  <div 
                    key={msg.id || index} 
                    className={`chat-history-item ${msg.role === 'user' ? 'user-msg' : 'assistant-msg'}`}
                  >
                    <div className="msg-role">
                      {msg.role === 'user' ? '👤 You' : '🤖 Agent'}
                    </div>
                    <div className="msg-content">
                      {typeof msg.content === 'string' 
                        ? msg.content 
                        : (msg.content?.text || JSON.stringify(msg.content))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-messages">
                <span className="empty-icon">💭</span>
                <p>No conversation yet. Start chatting with the agent!</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentPanel;
