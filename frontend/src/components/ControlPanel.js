import React, { useEffect, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import AgentPanel from './AgentPanel';
import { trackUxEvent } from '../utils/analytics';

function ControlPanel() {
  const {
    isPanelVisible,
    setIsPanelVisible,
    dataType,
    setDataType,
    yearControl,
    setYearControl,
    is3DEnabled,
    setIs3DEnabled,
    isBuildingsEnabled,
    setIsBuildingsEnabled,
    layerVisibility,
    toggleLayerVisibility,
    layerOpacity,
    updateLayerOpacity,
    resetAllOpacity,
    geeCodeUrl,
    setActiveModal,
    setCountries,
    selectedAOI,
    appMode,
    chatMode,
    setAppMode,
    setChatMode,
    setChatInput,
    setWarning,
    resetAskSession,
    resetAgentSession,
  } = useAppContext();

  const [selectedLayer, setSelectedLayer] = useState('');

  // Load countries data
  useEffect(() => {
    fetch('/assets/data/countries.json')
      .then((res) => res.json())
      .then((data) => setCountries(data))
      .catch((err) => console.error('Error loading countries:', err));
  }, [setCountries]);

  useEffect(() => {
    if (appMode !== 'agent' || typeof window === 'undefined') return undefined;

    const narrowAgentViewport = window.matchMedia('(max-width: 640px)');
    const collapseForNarrowAgentViewport = () => {
      if (narrowAgentViewport.matches) {
        setIsPanelVisible(false);
      }
    };

    collapseForNarrowAgentViewport();
    narrowAgentViewport.addEventListener?.('change', collapseForNarrowAgentViewport);

    return () => {
      narrowAgentViewport.removeEventListener?.('change', collapseForNarrowAgentViewport);
    };
  }, [appMode, setIsPanelVisible]);

  const handleCollapsePanel = () => {
    setIsPanelVisible(false);
  };

  const handleModeToggle = () => {
    const nextMode = chatMode === 'ask' ? 'agent' : 'ask';

    if (nextMode !== chatMode) {
      trackUxEvent('mode_switch', {
        from: chatMode,
        to: nextMode,
        entry: 'control_panel_header',
      });

      if (nextMode === 'agent') {
        resetAskSession();
      }

      if (chatMode === 'agent' || nextMode === 'agent') {
        resetAgentSession({ preserveSelectedAoi: true });
      }
    }

    setChatMode(nextMode);
    setAppMode(nextMode);
    setChatInput('');
    setWarning('');
  };

  const handleDataTypeChange = (type) => {
    if (type === dataType) return; // Already selected

    resetAskSession();
    
    // Set new data type
    setDataType(type);
    
    if (!selectedAOI) {
      setActiveModal('prompt');
    }
  };

  const handleLayerChange = (layerName) => {
    toggleLayerVisibility(layerName);
  };

  const handleOpacityChange = (e) => {
    if (!selectedLayer) return;
    const opacity = parseFloat(e.target.value);
    updateLayerOpacity(selectedLayer, opacity);
  };

  const handle3DToggle = () => {
    setIs3DEnabled(!is3DEnabled);
    if (!is3DEnabled) {
      setActiveModal('3d');
    }
  };

  const handleBuildingsToggle = () => {
    setIsBuildingsEnabled(!isBuildingsEnabled);
    if (!isBuildingsEnabled) {
      setActiveModal('3d');
    }
  };

  const activeLayerOrder = getAskLayerOrder();

  // Get visible layers for dropdown
  const visibleLayers = activeLayerOrder
    .filter((name) => layerVisibility[name])
    .map((name) => ({
      name,
      label: getLayerLabel(name),
    }));

  useEffect(() => {
    if (!selectedLayer) return;
    const isLayerStillAvailable = activeLayerOrder.includes(selectedLayer) && layerVisibility[selectedLayer];
    if (!isLayerStillAvailable) {
      setSelectedLayer('');
    }
  }, [activeLayerOrder, layerVisibility, selectedLayer]);

  if (!isPanelVisible) return null;

  return (
    <div className="panel">
      <header className="control-panel-header">
        <img 
          src="/assets/images/Sat-GPT-Logos-01.png" 
          alt="SatGPT Logo" 
          className="control-panel-logo"
        />
        <div className="control-panel-header-actions">
          <button
            type="button"
            className={`panel-mode-toggle-btn ${chatMode === 'agent' ? 'is-agent' : ''}`}
            onClick={handleModeToggle}
            title={`Switch to ${chatMode === 'ask' ? 'Agent' : 'Ask'} mode`}
            aria-label={`Switch to ${chatMode === 'ask' ? 'Agent' : 'Ask'} mode`}
          >
            <ArrowLeftRight size={13} strokeWidth={2.1} />
          </button>
          <button
            type="button"
            className="collapse-button"
            onClick={handleCollapsePanel}
            title="Collapse control panel"
            aria-label="Collapse control panel"
          >
            &#187;
          </button>
        </div>
      </header>
      
      <hr style={{ margin: '10px 0px 20px 0px' }} />

      <div className="panel-scroll">
        {appMode === 'agent' ? (
          <AgentPanel />
        ) : (
        <>
          {/* Layer Control Section */}
          <div className="slect-c">
            <h2>Layer Control</h2>
          
          <div style={{ paddingLeft: '10px' }}>
            <div>
              <input
                type="checkbox"
                className="select-box"
                id="historicalDataCheckbox"
                checked={dataType === 'historical'}
                onChange={() => handleDataTypeChange('historical')}
              />
              <span>Single Inundation Event</span>
            </div>
            <div>
              <input
                type="checkbox"
                className="select-box"
                id="floodHotspotCheckbox"
                checked={dataType === 'floodHotspot'}
                onChange={() => handleDataTypeChange('floodHotspot')}
              />
              <span>Inundation Hotspot</span>
            </div>
          </div>
        </div>

        {/* Year Control Slider */}
        <div id="yearControlledSlider">
          <p>Hotspot Duration</p>
          <div className="trp-range">
            <label>5 Years</label>
            <label>25 Years</label>
          </div>
          <input
            className="year-range-slider"
            type="range"
            min="5"
            max="25"
            value={yearControl}
            onChange={(e) => setYearControl(parseInt(e.target.value))}
            disabled={dataType !== 'floodHotspot'}
            style={{ '--slider-progress': `${((yearControl - 5) / 20) * 100}%` }}
          />
          <span className="year-slider-value">{yearControl} Years</span>
        </div>

        {/* 3D Toggle */}
        <div className="toggle-switcher-css">
          <label className="switch-label">3D</label>
          <div className="form-check form-switch">
            <input
              className="form-check-input"
              type="checkbox"
              checked={is3DEnabled}
              onChange={handle3DToggle}
            />
          </div>
          <label className="form-check-label">Buildings</label>
          <div className="form-check form-switch">
            <input
              className="form-check-input"
              type="checkbox"
              checked={isBuildingsEnabled}
              onChange={handleBuildingsToggle}
            />
          </div>
        </div>

        {/* Legend */}
        <div className="Legend-sec">
          <div className="heading-title">
            <h1>Legend</h1>
          </div>
          <div className="water-legends">
            <div className="legend-value">
              <div className="legend-block" style={{ backgroundColor: '#00008B' }}></div>
              <span>Permanent Water Body</span>
            </div>
            <div className="legend-value">
              <div className="legend-block" style={{ backgroundColor: '#FD0303' }}></div>
              <span>Inundated Area</span>
            </div>
          </div>
        </div>

        {/* Layers */}
        <div>
          <h4>Layers</h4>
          <div style={{ display: 'flex', flexDirection: 'row', paddingLeft: '10px' }}>
            <div style={{ width: '50%' }}>
              {getLeftColumnLayers().map((layerName) => (
                <LayerCheckbox
                  key={layerName}
                  name={layerName}
                  label={getLayerLabel(layerName)}
                  checked={layerVisibility[layerName]}
                  onChange={() => handleLayerChange(layerName)}
                />
              ))}
            </div>
            <div style={{ width: '50%' }}>
              {getRightColumnLayers(dataType).map((layerName) => (
                <LayerCheckbox
                  key={layerName}
                  name={layerName}
                  label={getLayerLabel(layerName)}
                  checked={layerVisibility[layerName]}
                  onChange={() => handleLayerChange(layerName)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Transparency Control */}
        <div className="transparency">
          <h4>Transparency</h4>
          <div style={{ paddingLeft: '10px' }}>
            <div className="transparency_layer">
              <select
                id="layerDropdown"
                value={selectedLayer}
                onChange={(e) => setSelectedLayer(e.target.value)}
              >
                <option disabled hidden value="">Choose Layer</option>
                {visibleLayers.map((layer) => (
                  <option key={layer.name} value={layer.name}>
                    {layer.label}
                  </option>
                ))}
              </select>
            </div>
            
            <div className="trp-range">
              <label>0%</label>
              <label>100%</label>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={selectedLayer ? layerOpacity[selectedLayer] : 1}
              onChange={handleOpacityChange}
              disabled={!selectedLayer}
            />
          </div>
          
          <div style={{ paddingLeft: '10px' }}>
            <h5 
              className="blue" 
              style={{ cursor: 'pointer' }}
              onClick={resetAllOpacity}
            >
              Reset Transparency for all
            </h5>
          </div>
        </div>

        {/* Download Button */}
        <div className="download-btn-div">
          <a
            href={geeCodeUrl || '#'}
            download="gee_code.js"
            className={`submit btn download ${!geeCodeUrl ? 'disabled' : ''}`}
            style={{ 
              opacity: geeCodeUrl ? 1 : 0.5,
              pointerEvents: geeCodeUrl ? 'auto' : 'none',
            }}
          >
            DOWNLOAD GEE CODE
          </a>
        </div>

        {/* Footer Links */}
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          <div 
            className="pages" 
            onClick={() => setActiveModal('contact')}
          >
            <i className="fa fa-comment-o"></i>
            <p>Contact Us</p>
          </div>
          <div 
            className="pages" 
            onClick={() => setActiveModal('help')}
          >
            <i className="fa fa-external-link"></i>
            <p>Help</p>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

function LayerCheckbox({ name, label, checked, onChange }) {
  return (
    <div className="layer-checkbox-item">
      <input
        type="checkbox"
        className="select-box"
        value={name}
        checked={checked}
        onChange={onChange}
      />
      <span>{label}</span>
    </div>
  );
}

function getLayerLabel(name) {
  const labels = {
    flood: 'Inundated Area',
    water: 'Permanent Water',
    lclu: 'LCLU',
    populationDensity: 'Population Density',
    soilTexture: 'Soil Texture',
    healthCareAccess: 'Healthcare Access',
  };
  return labels[name] || name;
}

function getAskLayerOrder() {
  return ['flood', 'water', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'];
}

function getLeftColumnLayers() {
  return ['flood', 'water', 'lclu', 'populationDensity'];
}

function getRightColumnLayers(dataType) {
  return ['soilTexture', 'healthCareAccess'];
}

export default ControlPanel;
