import React, { useMemo } from 'react';
import { Database, Droplets, Flame, Image as ImageIcon, Map as MapIcon, Mountain } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { getAgentRasterLayerNames } from '../config/agentRasterLayerConfig';
import { trackUxEvent } from '../utils/analytics';

const AGENT_MODULES = [
  {
    id: 'flood',
    label: 'Flood',
    title: 'Flood Analysis',
    accent: '#2563eb',
    Icon: Droplets,
  },
  {
    id: 'wildfire',
    label: 'Wildfire',
    title: 'Wildfire Analysis',
    accent: '#ea580c',
    Icon: Flame,
  },
  {
    id: 'landslide',
    label: 'Landslide',
    title: 'Landslide Analysis',
    accent: '#94a3b8',
    Icon: Mountain,
  },
  {
    id: 'context',
    label: 'Auxiliary',
    title: 'Auxiliary Resources',
    accent: '#0f766e',
    Icon: Database,
    sectionStart:true,
  },
  {
    id: 'imagery',
    label: 'Imagery',
    title: 'Optical and SAR Imagery',
    accent: '#7c3aed',
    Icon: ImageIcon,
    
  },
  {
    id: 'vector',
    label: 'Vector',
    title: 'Vector Layers',
    accent: '#16a34a',
    Icon: MapIcon,
  },
];

function AgentDisasterRail() {
  const {
    appMode,
    agentModule,
    setAgentModule,
    setWarning,
    layerData,
    agentRasterLayerVisibility,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentImagery,
    agentSelectedPeriod,
    agentShowBaseImagery,
    agentBaseImageryVisibility,
    agentShowFloodDetection,
    businessLayers,
  } = useAppContext();

  const loadedLayerCounts = useMemo(() => {
    const countRasterLayers = (moduleId) => (
      getAgentRasterLayerNames(moduleId).filter((layerKey) => (
        agentRasterLayerVisibility?.[layerKey]
        && layerData?.[layerKey]?.tileUrl
      )).length
    );
    const floodDetectionCount = (
      agentShowFloodDetection
      && agentImagery?.flood_detection?.tile_url
    ) ? 1 : 0;
    const recommendedCount = Object.entries(agentRecommendedLayerVisibility || {}).filter(([layerId, visible]) => (
      visible && agentRecommendedLayerData?.[layerId]?.tile_url
    )).length;
    const imageryCount = ['sentinel2', 'sentinel1'].filter((type) => (
      agentShowBaseImagery
      && agentBaseImageryVisibility?.[type]
      && agentImagery?.[agentSelectedPeriod]?.[type]?.tile_url
    )).length;
    const vectorCount = (businessLayers || []).filter((layer) => layer?.is_visible !== false).length;

    return {
      flood: countRasterLayers('flood') + floodDetectionCount + recommendedCount,
      wildfire: countRasterLayers('wildfire'),
      landslide: countRasterLayers('landslide'),
      context: countRasterLayers('context'),
      imagery: imageryCount,
      vector: vectorCount,
    };
  }, [
    agentBaseImageryVisibility,
    agentImagery,
    agentRasterLayerVisibility,
    agentRecommendedLayerData,
    agentRecommendedLayerVisibility,
    agentSelectedPeriod,
    agentShowBaseImagery,
    agentShowFloodDetection,
    businessLayers,
    layerData,
  ]);

  if (appMode !== 'agent') return null;

  const handleModuleChange = (moduleId) => {
    if (moduleId === agentModule) return;

    setAgentModule(moduleId);
    setWarning('');
    trackUxEvent('agent_module_switch', {
      from: agentModule,
      to: moduleId,
      entry: 'disaster_rail',
    });
  };

  return (
    <nav className="agent-disaster-rail" aria-label="Disaster agent modules">
      <div className="agent-disaster-rail__brand">
        <span>AGENT</span>
      </div>
      {AGENT_MODULES.map((module) => (
        <button
          type="button"
          key={module.id}
          className={[
  'agent-disaster-rail__item',
  module.sectionStart ? 'agent-disaster-rail__item--section-start' : '',
  agentModule === module.id ? 'active' : '',
].filter(Boolean).join(' ')}
          onClick={() => {
            if (!module.disabled) {
              handleModuleChange(module.id);
            }
          }}
          aria-pressed={agentModule === module.id}
          disabled={module.disabled}
          style={{ '--disaster-accent': module.accent }}
          title={module.title}
        >
          <span className="agent-disaster-rail__icon-wrap">
            <module.Icon size={25} strokeWidth={2.1} />
            <span className="agent-disaster-rail__badge">{loadedLayerCounts[module.id] || 0}</span>
          </span>
          <span className="agent-disaster-rail__label">{module.label}</span>
        </button>
      ))}
    </nav>
  );
}

export default AgentDisasterRail;
