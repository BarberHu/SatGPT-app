/**
 * Agent Control Panel Component
 * Displays flood agent controls: date selection, imagery type, layers, etc.
 * Chat interface is now in ChatBox component
 * Supports Human-in-the-Loop (HITL)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * 影像信息图标组件
 * 显示每种影像类型在各个时期的元数据（来源、拼接、可用性等）
 */
function ImageryInfoIcon({ imageryData, type, selectedPeriod }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const [copiedId, setCopiedId] = useState(null);
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  // 点击外部关闭 popover
  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        iconRef.current && !iconRef.current.contains(e.target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  // 复制到剪贴板
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  // 计算 popover 位置
  const handleTogglePopover = (e) => {
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const popoverWidth = 290;
      const popoverHeight = 380;
      // 默认在图标右侧显示
      let left = rect.right + 8;
      let top = rect.top - 10;
      // 如果右边放不下，放到左侧
      if (left + popoverWidth > window.innerWidth - 10) {
        left = rect.left - popoverWidth - 8;
      }
      // 如果左边也放不下，居中显示
      if (left < 10) {
        left = Math.max(10, (window.innerWidth - popoverWidth) / 2);
      }
      // 如果底部超出，往上调
      if (top + popoverHeight > window.innerHeight - 10) {
        top = window.innerHeight - popoverHeight - 10;
      }
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // 当前选中时期的影像数据
  const currentPeriodData = imageryData?.[selectedPeriod]?.[type];
  const hasError = currentPeriodData?.error;

  // 汇总三个时期的信息
  const allPeriodsInfo = [
    { key: 'pre_date', label: 'Pre-Flood' },
    { key: 'peek_date', label: 'Peak' },
    { key: 'after_date', label: 'Post-Flood' },
  ].map(({ key, label }) => ({
    key,
    label,
    data: imageryData?.[key]?.[type],
  }));

  // 统计无影像的时期数量
  const missingCount = allPeriodsInfo.filter(p => p.data?.error || p.data?.image_count === 0).length;

  const popoverContent = showPopover ? createPortal(
    <div
      className="imagery-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">
          {type === 'sentinel2' ? '🌍 Sentinel-2 Optical' : '📡 Sentinel-1 SAR'}
        </span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>✕</button>
      </div>
      <div className="popover-body">
        {allPeriodsInfo.map(({ key, label, data }) => (
          <div key={key} className={`period-info-block ${selectedPeriod === key ? 'current' : ''}`}>
            <div className="period-info-header">
              <span className="period-info-label">{label}</span>
              {data?.error ? (
                <span className="period-status-badge error">N/A</span>
              ) : (
                <span className="period-status-badge success">Available</span>
              )}
            </div>
            {data?.error ? (
              <div className="no-imagery-detail">
                <div className="no-imagery-msg">⚠️ {data.error}</div>
                {data.search_range && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Search Range</span>
                    <span className="meta-value">{data.search_range}</span>
                  </div>
                )}
              </div>
            ) : data ? (
              <div className="imagery-detail">
                <div className="imagery-meta-row">
                  <span className="meta-label">Date</span>
                  <span className="meta-value">{data.date || '-'}</span>
                </div>
                {data.requested_date && data.date !== data.requested_date && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Requested</span>
                    <span className="meta-value">{data.requested_date}</span>
                  </div>
                )}
                <div className="imagery-meta-row">
                  <span className="meta-label">Satellite</span>
                  <span className="meta-value">{data.spacecraft || data.type || (type === 'sentinel2' ? 'Sentinel-2' : 'Sentinel-1')}</span>
                </div>
                <div className="imagery-meta-row">
                  <span className="meta-label">Mosaic</span>
                  <span className="meta-value">
                    {data.mosaic ? `Yes (${data.image_count} tiles)` : 'Single scene'}
                  </span>
                </div>
                {data.actual_date_range && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Date Range</span>
                    <span className="meta-value">{data.actual_date_range}</span>
                  </div>
                )}
                {data.cloud_cover !== undefined && data.cloud_cover !== null && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Cloud</span>
                    <span className="meta-value">{Number(data.cloud_cover).toFixed(1)}%</span>
                  </div>
                )}
                {data.polarization && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Polarization</span>
                    <span className="meta-value">{data.polarization}</span>
                  </div>
                )}
                {data.orbit_pass && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Orbit</span>
                    <span className="meta-value">{data.orbit_pass}</span>
                  </div>
                )}
                {data.resolution && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Resolution</span>
                    <span className="meta-value">{data.resolution}m</span>
                  </div>
                )}
                {data.mgrs_tile && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">MGRS Tile</span>
                    <span className="meta-value">{data.mgrs_tile}</span>
                  </div>
                )}
                {data.id && data.id !== 'unknown' && (
                  <div className="imagery-meta-row">
                    <span className="meta-label">Image ID</span>
                    <span
                      className={`meta-value id-value clickable ${copiedId === data.id ? 'copied' : ''}`}
                      title={`${data.id}\nClick to copy`}
                      onClick={() => copyToClipboard(data.id)}
                    >
                      {copiedId === data.id ? '✓ Copied!' : data.id}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="no-imagery-detail">
                <div className="no-imagery-msg">No data available</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className="imagery-info-wrapper">
      <span
        ref={iconRef}
        className={`imagery-info-icon ${hasError ? 'warning' : missingCount > 0 ? 'caution' : 'ok'}`}
        onClick={handleTogglePopover}
        title={hasError ? 'No imagery available for this period. Click for details.' : 'Click to view imagery source info'}
      >
        {hasError ? '!' : missingCount > 0 ? '!' : 'i'}
      </span>
      {popoverContent}
    </div>
  );
}

/**
 * Layer data source metadata (static info for each analysis layer)
 */
const LAYER_META = {
  flood_detection: {
    icon: '🌊',
    title: 'Flood Detection',
    source: 'Sentinel-1 GRD (C-band SAR)',
    method: 'Otsu Change Detection',
    resolution: '10m',
    auxiliary: 'JRC Global Surface Water v1.4',
    description: 'Detects newly flooded areas by comparing pre-flood and peak SAR backscatter, using Otsu thresholding on the change index. Permanent water bodies are excluded via JRC occurrence data.',
  },
  population: {
    icon: '👥',
    title: 'Population Impact',
    source: 'WorldPop — Global 100m Population',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Estimates affected population by overlaying the flood mask on WorldPop gridded population density.',
  },
  urban: {
    icon: '🏙️',
    title: 'Built-up Area',
    source: 'GHSL Built-up Surface 2020 (JRC)',
    method: 'Zonal Statistics',
    resolution: '100m',
    auxiliary: null,
    description: 'Calculates the flooded built-up area using the Global Human Settlement Layer.',
  },
  landcover: {
    icon: '🌳',
    title: 'Land Cover',
    source: 'ESA WorldCover 2021 (v200)',
    method: 'Per-class Area Calculation',
    resolution: '10m',
    auxiliary: null,
    description: 'Breaks down flooded area by ESA WorldCover classes (cropland, forest, built-up, grassland, etc.).',
  },
};

/**
 * Analysis Layer info icon — shows data source & stats for each layer
 */
function LayerInfoIcon({ layerType, floodDetectionData, impactData }) {
  const [showPopover, setShowPopover] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const popoverRef = useRef(null);
  const iconRef = useRef(null);

  const meta = LAYER_META[layerType];

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        iconRef.current && !iconRef.current.contains(e.target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopover]);

  if (!meta) return null;

  // Compute popover position
  const handleToggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!showPopover && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const pw = 300, ph = 320;
      let left = rect.right + 8;
      let top = rect.top - 10;
      if (left + pw > window.innerWidth - 10) left = rect.left - pw - 8;
      if (left < 10) left = Math.max(10, (window.innerWidth - pw) / 2);
      if (top + ph > window.innerHeight - 10) top = window.innerHeight - ph - 10;
      if (top < 10) top = 10;
      setPopoverPos({ top, left });
    }
    setShowPopover(!showPopover);
  };

  // Build dynamic stats rows
  const statsRows = [];
  if (layerType === 'flood_detection' && floodDetectionData) {
    if (floodDetectionData.stats?.flood_area_km2 != null) {
      statsRows.push({ label: 'Flooded Area', value: `${floodDetectionData.stats.flood_area_km2} km²` });
    }
    if (floodDetectionData.pre_date) statsRows.push({ label: 'Pre-flood Date', value: floodDetectionData.pre_date });
    if (floodDetectionData.peek_date) statsRows.push({ label: 'Peak Date', value: floodDetectionData.peek_date });
  }
  if (layerType === 'population' && impactData?.population && !impactData.population.error) {
    const p = impactData.population;
    statsRows.push({ label: 'Affected', value: `${(p.affected || 0).toLocaleString()} people` });
    statsRows.push({ label: 'Total in Region', value: `${(p.total || 0).toLocaleString()} people` });
    if (p.percentage != null) statsRows.push({ label: 'Percentage', value: `${p.percentage}%` });
    if (p.data_source) statsRows.push({ label: 'Data Year', value: p.data_source });
  }
  if (layerType === 'urban' && impactData?.urban && !impactData.urban.error) {
    const u = impactData.urban;
    statsRows.push({ label: 'Affected Built-up', value: `${u.affected_area_km2} km²` });
    statsRows.push({ label: 'Total Built-up', value: `${u.total_area_km2} km²` });
    if (u.percentage != null) statsRows.push({ label: 'Percentage', value: `${u.percentage}%` });
  }
  if (layerType === 'landcover' && impactData?.landcover && !impactData.landcover.error) {
    const lc = impactData.landcover;
    if (lc.breakdown) {
      Object.entries(lc.breakdown).forEach(([key, val]) => {
        statsRows.push({ label: key.charAt(0).toUpperCase() + key.slice(1), value: `${val.area_km2} km²` });
      });
    }
  }

  const hasStats = statsRows.length > 0;

  const popoverContent = showPopover ? createPortal(
    <div
      className="layer-info-popover"
      ref={popoverRef}
      style={{ top: popoverPos.top, left: popoverPos.left }}
    >
      <div className="popover-header">
        <span className="popover-title">{meta.icon} {meta.title}</span>
        <button className="popover-close" onClick={() => setShowPopover(false)}>✕</button>
      </div>
      <div className="popover-body">
        <div className="layer-meta-section">
          <div className="layer-meta-subtitle">Data Source</div>
          <div className="imagery-meta-row">
            <span className="meta-label">Source</span>
            <span className="meta-value">{meta.source}</span>
          </div>
          <div className="imagery-meta-row">
            <span className="meta-label">Method</span>
            <span className="meta-value">{meta.method}</span>
          </div>
          <div className="imagery-meta-row">
            <span className="meta-label">Resolution</span>
            <span className="meta-value">{meta.resolution}</span>
          </div>
          {meta.auxiliary && (
            <div className="imagery-meta-row">
              <span className="meta-label">Auxiliary</span>
              <span className="meta-value">{meta.auxiliary}</span>
            </div>
          )}
        </div>
        {hasStats && (
          <div className="layer-meta-section">
            <div className="layer-meta-subtitle">Statistics</div>
            {statsRows.map((row, i) => (
              <div key={i} className="imagery-meta-row">
                <span className="meta-label">{row.label}</span>
                <span className="meta-value">{row.value}</span>
              </div>
            ))}
          </div>
        )}
        <div className="layer-meta-description">{meta.description}</div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span
      ref={iconRef}
      className="layer-info-icon"
      onClick={handleToggle}
      title="Click to view data source info"
    >
      ⓘ
      {popoverContent}
    </span>
  );
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
    agentLayerLoading,
    agentTileError,
  } = useAppContext();
  
  // Get chat messages from CopilotKit (with safety check)
  const messagesContext = useCopilotMessagesContext();
  const messages = messagesContext?.messages || [];
  
  // Local UI state (for section expansion only)
  const [sourcesDrawerOpen, setSourcesDrawerOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    event: true,
    dates: false,
    imagery: false,
    layers: false,
    impact: false,
    chatHistory: false,
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

  // Auto-fetch impact data in background as soon as imagery arrives
  useEffect(() => {
    if (agentImagery && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [agentImagery, agentImpactData, agentImpactLoading, fetchImpactData]);

  // Also fetch if user enables an impact layer before data arrived
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
                      disabled={agentLayerLoading['base-imagery']}
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
              <div className="imagery-type-item">
                <button
                  className={`type-btn ${agentSelectedType === 'sentinel2' ? 'active' : ''}`}
                  onClick={() => setAgentSelectedType('sentinel2')}
                  disabled={agentLayerLoading['base-imagery']}
                >
                  🌍 Optical (S2)
                </button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel2')) ? (
                  <span className="imagery-spinner" title="Loading..." />
                ) : agentImagery ? (
                  <ImageryInfoIcon
                    imageryData={agentImagery}
                    type="sentinel2"
                    selectedPeriod={agentSelectedPeriod}
                  />
                ) : null}
              </div>
              <div className="imagery-type-item">
                <button
                  className={`type-btn ${agentSelectedType === 'sentinel1' ? 'active' : ''}`}
                  onClick={() => setAgentSelectedType('sentinel1')}
                  disabled={agentLayerLoading['base-imagery']}
                >
                  📡 SAR Radar (S1)
                </button>
                {(agentImageryLoading || (agentLayerLoading['base-imagery'] && agentSelectedType === 'sentinel1')) ? (
                  <span className="imagery-spinner" title="Loading..." />
                ) : agentImagery ? (
                  <ImageryInfoIcon
                    imageryData={agentImagery}
                    type="sentinel1"
                    selectedPeriod={agentSelectedPeriod}
                  />
                ) : null}
              </div>
            </div>

    
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
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowFloodDetection}
                    onChange={() => setAgentShowFloodDetection(!agentShowFloodDetection)}
                  />
                  <span className="layer-icon">🌊</span>
                  <span>Flood Detection</span>
                </label>
                {agentLayerLoading['flood-detection'] ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="flood_detection"
                    floodDetectionData={agentImagery?.flood_detection}
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowPopulationLayer}
                    onChange={() => setAgentShowPopulationLayer(!agentShowPopulationLayer)}
                  />
                  <span className="layer-icon">👥</span>
                  <span>Population Impact</span>
                </label>
                {(agentLayerLoading['population'] || (agentShowPopulationLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="population"
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowUrbanLayer}
                    onChange={() => setAgentShowUrbanLayer(!agentShowUrbanLayer)}
                  />
                  <span className="layer-icon">🏙️</span>
                  <span>Built-up Area</span>
                </label>
                {(agentLayerLoading['urban'] || (agentShowUrbanLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="urban"
                    impactData={agentImpactData}
                  />
                )}
              </div>
              
              <div className="layer-toggle-row">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={agentShowLandcoverLayer}
                    onChange={() => setAgentShowLandcoverLayer(!agentShowLandcoverLayer)}
                  />
                  <span className="layer-icon">🌳</span>
                  <span>Land Cover</span>
                </label>
                {(agentLayerLoading['landcover'] || (agentShowLandcoverLayer && agentImpactLoading)) ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <LayerInfoIcon
                    layerType="landcover"
                    impactData={agentImpactData}
                  />
                )}
              </div>
            </div>

            {/* Tile Error Warning */}
            {agentTileError && (
              <div className="tile-error-banner">
                <span className="tile-error-icon">⚠️</span>
                <span className="tile-error-msg">{agentTileError.message}</span>
              </div>
            )}
            
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
