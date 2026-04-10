import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCoAgent, useCopilotMessagesContext, useLangGraphInterrupt } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import EventConfirmation from './EventConfirmation';
import SourcesDrawer from './SourcesDrawer';
import AoiUploadPanel from './AoiUploadPanel';
import { getFloodImages, getFloodImpact } from '../services/agentApi';
import { buildAoiFromAgentState } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import './AgentPanel.css';

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
  aoi_source: null,
  search_sources: null,
  gee_code: null,
  is_valid_flood_query: false,
  agent_intent: null,
  query_themes: [],
  recommended_assets: [],
  selected_asset_ids: [],
  water_asset_layers: [],
  token_usage: [],
  token_cost_summary: {},
};

const extractMessageText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return content?.text || JSON.stringify(content || '');
};

const downloadTextFile = (content, filename, mimeType) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const InfoPill = ({ children, title }) => (
  <span className="dataset-badge dataset-badge-muted" title={title || ''}>{children}</span>
);

function DatasetInfoIcon({ asset }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  useEffect(() => {
    if (!showPopover) return undefined;
    const handleClickOutside = (event) => {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target) &&
        iconRef.current && !iconRef.current.contains(event.target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  const handleToggle = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const popoverWidth = 310;
      const popoverHeight = 280;
      let left = rect.right + 8;
      let top = rect.top - 8;
      if (left + popoverWidth > window.innerWidth - 10) left = rect.left - popoverWidth - 8;
      if (left < 10) left = Math.max(10, (window.innerWidth - popoverWidth) / 2);
      if (top + popoverHeight > window.innerHeight - 10) top = window.innerHeight - popoverHeight - 10;
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover((value) => !value);
  };

  const popover = showPopover ? createPortal(
    <div
      className="dataset-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">{asset.title}</span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>✕</button>
      </div>
      <div className="popover-body">
        <div className="layer-meta-section">
          <div className="layer-meta-subtitle">Dataset</div>
          <div className="imagery-meta-row">
            <span className="meta-label">Asset ID</span>
            <span className="meta-value">{asset.asset_id}</span>
          </div>
          {asset.asset_type && (
            <div className="imagery-meta-row">
              <span className="meta-label">Type</span>
              <span className="meta-value">{asset.asset_type}</span>
            </div>
          )}
          {asset.temporal_type && (
            <div className="imagery-meta-row">
              <span className="meta-label">Temporal</span>
              <span className="meta-value">{asset.temporal_type}</span>
            </div>
          )}
          {!!asset.themes?.length && (
            <div className="imagery-meta-row">
              <span className="meta-label">Themes</span>
              <span className="meta-value">{asset.themes.join(', ')}</span>
            </div>
          )}
        </div>
        {asset.summary && (
          <div className="layer-meta-section">
            <div className="layer-meta-subtitle">Summary</div>
            <div className="layer-meta-description dataset-popover-copy">{asset.summary}</div>
          </div>
        )}
        {asset.notes && (
          <div className="layer-meta-section">
            <div className="layer-meta-subtitle">Notes</div>
            <div className="layer-meta-description dataset-popover-copy">{asset.notes}</div>
          </div>
        )}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <span
        ref={iconRef}
        className="dataset-info-icon"
        onClick={handleToggle}
        title="View dataset details"
      >
        !
      </span>
      {popover}
    </>
  );
}

function AgentPanel() {
  const {
    setFloodAgentState,
    floodAgentState,
    selectedAOI,
    setWarning,
    setAgentImagery,
    setAgentImageryLoading,
    agentImagery,
    agentImageryLoading,
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
    agentLayerLoading,
    setAgentTileError,
    agentTileError,
  } = useAppContext();

  const messagesContext = useCopilotMessagesContext();
  const messages = messagesContext?.messages || [];
  const { state } = useCoAgent({ name: "flood_agent", initialState: defaultAgentState });

  const [drawerState, setDrawerState] = useState({ open: false, mode: 'search' });
  const [expandedSections, setExpandedSections] = useState({
    event: true,
    datasets: true,
    impact: false,
    dates: false,
    imagery: false,
    layers: false,
    chatHistory: false,
  });

  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);

  useEffect(() => {
    if (state) setFloodAgentState(state);
  }, [setFloodAgentState, state]);

  const currentState = state || floodAgentState;
  const effectiveAoi = selectedAOI || buildAoiFromAgentState(currentState, {
    source: 'agent_geocode',
    label: currentState.location || 'Agent-derived boundary',
  });

  const recommendedAssets = useMemo(() => currentState.recommended_assets || [], [currentState.recommended_assets]);
  const selectedAssetIds = useMemo(() => currentState.selected_asset_ids || [], [currentState.selected_asset_ids]);
  const selectedAssetSet = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);
  const waterLayers = currentState.water_asset_layers || [];

  const drawerSources = useMemo(() => {
    if (drawerState.mode === 'datasets') {
      return recommendedAssets.map((asset) => ({
        title: asset.title,
        url: asset.official_url,
        asset_id: asset.asset_id,
        summary: asset.summary,
        notes: asset.notes,
      }));
    }
    return currentState.search_sources || [];
  }, [currentState.search_sources, drawerState.mode, recommendedAssets]);

  useEffect(() => {
    const summary = currentState.token_cost_summary;
    if (summary?.total_tokens) {
      console.log('[water-agent-token-summary]', summary);
    }
  }, [currentState.token_cost_summary]);

  const fetchAgentImagery = useCallback(async (agentState, aoi) => {
    const requestKey = JSON.stringify({
      pre_date: agentState.pre_date,
      peek_date: agentState.peek_date,
      after_date: agentState.after_date,
      bounds: aoi?.bounds || agentState.bounds || null,
      geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      coordinates: agentState.coordinates || null,
    });
    if (imageryRequestKeyRef.current === requestKey) return;

    imageryRequestKeyRef.current = requestKey;
    impactRequestKeyRef.current = null;
    setAgentImagery(null);
    setAgentImpactData(null);
    setAgentTileError(null);
    setAgentImageryLoading(true);
    setWarning('');

    try {
      const result = await getFloodImages({
        pre_date: agentState.pre_date,
        peek_date: agentState.peek_date,
        after_date: agentState.after_date,
        longitude: agentState.coordinates?.[0] || 0,
        latitude: agentState.coordinates?.[1] || 0,
        bounds: aoi?.bounds || agentState.bounds || null,
        geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      });
      if (imageryRequestKeyRef.current !== requestKey) return;
      if (!result?.success) throw new Error('Flood imagery response was not successful.');
      setAgentImagery(result.data);
      setWarning('');
    } catch (error) {
      if (imageryRequestKeyRef.current !== requestKey) return;
      imageryRequestKeyRef.current = null;
      setWarning(error?.message || 'Flood imagery request failed.');
    } finally {
      if (imageryRequestKeyRef.current === requestKey) setAgentImageryLoading(false);
    }
  }, [setAgentImagery, setAgentImageryLoading, setAgentImpactData, setAgentTileError, setWarning]);

  useEffect(() => {
    if (!currentState.pre_date || !currentState.peek_date || !currentState.after_date) {
      imageryRequestKeyRef.current = null;
      return;
    }
    if (effectiveAoi || currentState.coordinates) {
      fetchAgentImagery(currentState, effectiveAoi);
    }
  }, [currentState, currentState.pre_date, currentState.peek_date, currentState.after_date, currentState.coordinates, effectiveAoi, fetchAgentImagery]);

  const fetchImpactData = useCallback(async () => {
    if (!currentState.pre_date || !currentState.peek_date) return;
    const requestKey = JSON.stringify({
      pre_date: currentState.pre_date,
      peek_date: currentState.peek_date,
      bounds: effectiveAoi?.bounds || currentState.bounds || null,
      geojson: effectiveAoi?.geojson?.geometry || currentState.geojson?.geometry || currentState.geojson || null,
    });
    if (impactRequestKeyRef.current === requestKey && agentImpactData) return;

    impactRequestKeyRef.current = requestKey;
    setAgentImpactLoading(true);
    setWarning('');
    try {
      const result = await getFloodImpact({
        pre_date: currentState.pre_date,
        peek_date: currentState.peek_date,
        bounds: effectiveAoi?.bounds || currentState.bounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentState.geojson || null,
      });
      if (impactRequestKeyRef.current !== requestKey) return;
      if (result?.success) setAgentImpactData(result.data);
    } catch (error) {
      if (impactRequestKeyRef.current !== requestKey) return;
      impactRequestKeyRef.current = null;
      setWarning(error?.message || 'Flood impact request failed.');
    } finally {
      if (impactRequestKeyRef.current === requestKey) setAgentImpactLoading(false);
    }
  }, [agentImpactData, currentState, effectiveAoi, setAgentImpactData, setAgentImpactLoading, setWarning]);

  useEffect(() => {
    if (!currentState.pre_date || !currentState.peek_date) {
      impactRequestKeyRef.current = null;
      return;
    }
    if (agentImagery && !agentImpactData && !agentImpactLoading) fetchImpactData();
  }, [agentImagery, agentImpactData, agentImpactLoading, currentState.pre_date, currentState.peek_date, fetchImpactData]);

  useEffect(() => {
    if ((agentShowPopulationLayer || agentShowUrbanLayer || agentShowLandcoverLayer) && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentShowPopulationLayer, agentShowUrbanLayer, agentShowLandcoverLayer, agentImpactData, agentImpactLoading, fetchImpactData]);

  useLangGraphInterrupt({
    enabled: ({ eventValue }) => eventValue?.type === "confirm_flood_event",
    render: ({ event, resolve }) => {
      const interruptData = event.value;
      return (
        <EventConfirmation
          data={interruptData.data}
          message={interruptData.message}
          onConfirm={(confirmedData) => {
            trackUxEvent('agent_confirmation_confirm', {
              event: confirmedData?.event || interruptData.data?.event || null,
              selected_count: confirmedData?.selected_asset_ids?.length || 0,
            });
            resolve(JSON.stringify(confirmedData));
          }}
          onCancel={() => {
            trackUxEvent('agent_confirmation_cancel', { event: interruptData.data?.event || null });
            resolve(JSON.stringify({ cancelled: true }));
          }}
        />
      );
    },
  });

  const toggleSection = (section) => {
    setExpandedSections((previous) => ({ ...previous, [section]: !previous[section] }));
  };

  const hasValidDates = currentState.pre_date && currentState.peek_date && currentState.after_date;
  const periods = [
    { key: 'pre_date', label: 'Pre-Flood', date: currentState.pre_date },
    { key: 'peek_date', label: 'Peak', date: currentState.peek_date },
    { key: 'after_date', label: 'Post-Flood', date: currentState.after_date },
  ];

  return (
    <div className="agent-panel-controls">
      <SourcesDrawer
        sources={drawerSources}
        isOpen={drawerState.open}
        onClose={() => setDrawerState((previous) => ({ ...previous, open: false }))}
      />

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
                <div className="info-row"><span className="info-label">Event:</span><span className="info-value">{currentState.event}</span></div>
                {currentState.location && <div className="info-row"><span className="info-label">Location:</span><span className="info-value">{currentState.location}</span></div>}
                {currentState.event_description && <div className="info-row description"><span className="info-value">{currentState.event_description}</span></div>}
                <div className="action-buttons">
                  {currentState.search_sources?.length > 0 && <button className="action-btn" onClick={() => setDrawerState({ open: true, mode: 'search' })}>Sources ({currentState.search_sources.length})</button>}
                  {recommendedAssets.length > 0 && <button className="action-btn" onClick={() => setDrawerState({ open: true, mode: 'datasets' })}>Dataset Sources</button>}
                  {currentState.flood_report && (
                    <button
                      className="action-btn"
                      onClick={() => downloadTextFile(
                        currentState.flood_report,
                        `${currentState.event || 'flood_analysis_report'}_${new Date().toISOString().split('T')[0]}.md`,
                        'text/markdown;charset=utf-8'
                      )}
                    >
                      Download Report
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="no-data-hint"><span>Ask about a flood event in the chat first.</span></div>
            )}
          </div>
        )}
      </div>

      <div className={`control-section ${expandedSections.datasets ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('datasets')}>
          <span className="section-icon">🗂️</span>
          <span className="section-title">Recommended Datasets</span>
          <span className={`expand-icon ${expandedSections.datasets ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.datasets && (
          <div className="section-body">
            {recommendedAssets.length > 0 ? (
              <>
                <div className="dataset-panel-actions">
                  <button className="action-btn" onClick={() => setDrawerState({ open: true, mode: 'datasets' })}>View Official Sources</button>
                </div>
                <div className="dataset-list compact-dataset-list">
                  {recommendedAssets.map((asset) => (
                    <div key={asset.asset_id} className={`dataset-card compact-dataset-card ${selectedAssetSet.has(asset.asset_id) ? 'selected' : ''}`}>
                      <div className="dataset-card-header">
                        <div className="dataset-title">{asset.title}</div>
                        <div className="dataset-header-actions">
                          <DatasetInfoIcon asset={asset} />
                          {selectedAssetSet.has(asset.asset_id) && <span className="dataset-status">Selected</span>}
                        </div>
                      </div>
                      <div className="dataset-compact-meta">
                        {asset.temporal_type && <InfoPill>{asset.temporal_type}</InfoPill>}
                        {asset.asset_type && <InfoPill>{asset.asset_type}</InfoPill>}
                      </div>
                    </div>
                  ))}
                </div>
                {waterLayers.length > 0 && (
                  <div className="dataset-loaded-group">
                    <div className="layer-meta-subtitle">Loaded Dataset Layers</div>
                    <div className="dataset-list">
                      {waterLayers.map((layer) => (
                        <div key={layer.layer_id} className="dataset-card selected">
                          <div className="dataset-card-header">
                            <div className="dataset-title">{layer.title}</div>
                            <span className="dataset-status">Loaded</span>
                          </div>
                          <div className="dataset-id">{layer.asset_id}</div>
                          {layer.location && <div className="dataset-note">Focus area: {layer.location}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="no-data-hint"><span>Recommended datasets will appear after the event is confirmed.</span></div>
            )}
          </div>
        )}
      </div>

      <div className={`control-section ${expandedSections.impact ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('impact')}>
          <span className="section-icon">📊</span>
          <span className="section-title">Impact Assessment</span>
          <span className={`expand-icon ${expandedSections.impact ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.impact && (
          <div className="section-body">
            {agentImpactLoading ? (
              <div className="loading-indicator"><span className="spinner">⏳</span><span>Calculating impact assessment...</span></div>
            ) : agentImpactData ? (
              <div className="impact-stats">
                <div className="impact-stat-item"><span className="impact-icon">🌊</span><span className="impact-label">Flooded Area</span><span className="impact-value">{agentImagery?.flood_detection?.stats?.flood_area_km2 || agentImpactData.flood_area?.value?.toFixed(2) || 0} km²</span></div>
                <div className="impact-stat-item"><span className="impact-icon">👥</span><span className="impact-label">Affected Population</span><span className="impact-value">{(agentImpactData.population?.affected || 0).toLocaleString()}</span></div>
                <div className="impact-stat-item"><span className="impact-icon">🏙️</span><span className="impact-label">Built-up Flooded</span><span className="impact-value">{agentImpactData.urban?.affected_area_km2?.toFixed(2) || 0} km²</span></div>
                <div className="impact-source">Data: WorldPop · ESA WorldCover · GHSL</div>
              </div>
            ) : (
              <div className="no-impact-data">
                <p>Enable analysis layers to calculate impact.</p>
                <button className="load-impact-btn" onClick={fetchImpactData} disabled={!currentState?.pre_date || !currentState?.peek_date}>Calculate Now</button>
              </div>
            )}
          </div>
        )}
      </div>

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
                {periods.map((period) => (
                  <div key={period.key} className="timeline-item">
                    <button className={`date-btn ${agentSelectedPeriod === period.key ? 'active' : ''}`} onClick={() => setAgentSelectedPeriod(period.key)} disabled={agentLayerLoading['base-imagery']}>
                      <span className="period-label">{period.label}</span>
                      <span className="period-date">{period.date || '-'}</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-data-hint"><span>Dates will appear after the event is confirmed.</span></div>
            )}
          </div>
        )}
      </div>

      <div className={`control-section ${expandedSections.imagery ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('imagery')}>
          <span className="section-icon">🛰️</span>
          <span className="section-title">Imagery Type</span>
          <span className={`expand-icon ${expandedSections.imagery ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.imagery && (
          <div className="section-body">
            <div className="imagery-type-buttons">
              <div className="imagery-type-item">
                <button className={`type-btn ${agentSelectedType === 'sentinel2' ? 'active' : ''}`} onClick={() => setAgentSelectedType('sentinel2')} disabled={agentLayerLoading['base-imagery']}>Optical (S2)</button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel2')) ? <span className="imagery-spinner" title="Loading..." /> : agentImagery?.[agentSelectedPeriod]?.sentinel2?.date ? <InfoPill title={agentImagery?.[agentSelectedPeriod]?.sentinel2?.date}>date</InfoPill> : null}
              </div>
              <div className="imagery-type-item">
                <button className={`type-btn ${agentSelectedType === 'sentinel1' ? 'active' : ''}`} onClick={() => setAgentSelectedType('sentinel1')} disabled={agentLayerLoading['base-imagery']}>SAR Radar (S1)</button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel1')) ? <span className="imagery-spinner" title="Loading..." /> : agentImagery?.[agentSelectedPeriod]?.sentinel1?.date ? <InfoPill title={agentImagery?.[agentSelectedPeriod]?.sentinel1?.date}>date</InfoPill> : null}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={`control-section ${expandedSections.layers ? 'expanded' : ''}`}>
        <div className="section-header" onClick={() => toggleSection('layers')}>
          <span className="section-icon">🗺️</span>
          <span className="section-title">Analysis Layers</span>
          <span className={`expand-icon ${expandedSections.layers ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.layers && (
          <div className="section-body">
            <div className="layer-toggles">
              <div className="layer-toggle-row"><label className="layer-toggle"><input type="checkbox" checked={agentShowFloodDetection} onChange={() => setAgentShowFloodDetection(!agentShowFloodDetection)} /><span className="layer-icon">🌊</span><span>Flood Detection</span></label></div>
              <div className="layer-toggle-row"><label className="layer-toggle"><input type="checkbox" checked={agentShowPopulationLayer} onChange={() => setAgentShowPopulationLayer(!agentShowPopulationLayer)} /><span className="layer-icon">👥</span><span>Population Impact</span></label></div>
              <div className="layer-toggle-row"><label className="layer-toggle"><input type="checkbox" checked={agentShowUrbanLayer} onChange={() => setAgentShowUrbanLayer(!agentShowUrbanLayer)} /><span className="layer-icon">🏙️</span><span>Built-up Area</span></label></div>
              <div className="layer-toggle-row"><label className="layer-toggle"><input type="checkbox" checked={agentShowLandcoverLayer} onChange={() => setAgentShowLandcoverLayer(!agentShowLandcoverLayer)} /><span className="layer-icon">🌳</span><span>Land Cover</span></label></div>
            </div>
            {agentTileError && <div className="tile-error-banner"><span className="tile-error-icon">⚠️</span><span className="tile-error-msg">{agentTileError.message}</span></div>}
            <div className="layer-legend">
              <h5>Legend</h5>
              <div className="legend-items">
                {agentShowFloodDetection && <div className="legend-item"><span className="legend-color" style={{ background: '#ff4444' }}></span><span>Flooded Area</span></div>}
                {agentShowPopulationLayer && <div className="legend-item"><span className="legend-gradient population"></span><span>Population Density</span></div>}
                {agentShowUrbanLayer && <div className="legend-item"><span className="legend-color" style={{ background: '#ff6600' }}></span><span>Built-up</span></div>}
                {agentShowLandcoverLayer && <div className="legend-row"><div className="legend-item-small"><span className="legend-dot" style={{ background: '#006400' }}></span><span>Forest</span></div><div className="legend-item-small"><span className="legend-dot" style={{ background: '#ffbb22' }}></span><span>Crop</span></div><div className="legend-item-small"><span className="legend-dot" style={{ background: '#0064c8' }}></span><span>Water</span></div></div>}
              </div>
            </div>
          </div>
        )}
      </div>

      <AoiUploadPanel variant="agent" />

      <div className="control-section">
        <div className="section-header" onClick={() => toggleSection('chatHistory')}>
          <span className="section-icon">💬</span>
          <span className="section-title">Chat History</span>
          <span className={`expand-icon ${expandedSections.chatHistory ? 'expanded' : ''}`}>▼</span>
        </div>
        {expandedSections.chatHistory && (
          <div className="section-body chat-history-section">
            {messages.length > 0 ? (
              <div className="chat-history-list">
                {messages.map((message, index) => (
                  <div key={message.id || index} className={`chat-history-item ${message.role === 'user' ? 'user-msg' : 'assistant-msg'}`}>
                    <div className="msg-role">{message.role === 'user' ? 'You' : 'Agent'}</div>
                    <div className="msg-content">{extractMessageText(message.content)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-messages"><span className="empty-icon">💭</span><p>No conversation yet. Start chatting with the agent.</p></div>
            )}
          </div>
        )}
      </div>

      <div className="agent-download-bar">
        <button
          type="button"
          className={`action-btn primary agent-download-btn ${!currentState.gee_code ? 'disabled' : ''}`}
          onClick={() => {
            if (!currentState.gee_code) return;
            trackUxEvent('export_gee_code', { event: currentState.event || null, mode: 'agent' });
            downloadTextFile(
              currentState.gee_code,
              `${(currentState.event || 'flood_analysis').replace(/\s+/g, '_')}_GEE_${new Date().toISOString().split('T')[0]}.js`,
              'text/javascript;charset=utf-8'
            );
          }}
          style={{ cursor: currentState.gee_code ? 'pointer' : 'not-allowed', opacity: currentState.gee_code ? 1 : 0.5, pointerEvents: currentState.gee_code ? 'auto' : 'none' }}
        >
          DOWNLOAD GEE CODE
        </button>
      </div>
    </div>
  );
}

export default AgentPanel;
