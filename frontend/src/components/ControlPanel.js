import React, { useEffect, useState } from 'react';
import { useAppContext } from '../context/AppContext';

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
    countries,
    setCountries,
    mapInstance,
    selectedGridCords,
    setSelectedGridCords,
    updateLayerData,
  } = useAppContext();

  const [selectedLayer, setSelectedLayer] = useState('');

  // Load countries data
  useEffect(() => {
    fetch('/static/countries.json')
      .then((res) => res.json())
      .then((data) => setCountries(data))
      .catch((err) => console.error('Error loading countries:', err));
  }, [setCountries]);

  if (!isPanelVisible) return null;

  const handleCollapsePanel = () => {
    setIsPanelVisible(false);
  };

  const handleDataTypeChange = (type) => {
    if (type === dataType) return; // Already selected
    
    // Clear previous layers from map
    if (mapInstance) {
      // Remove EE tile layers
      ['water-layer', 'flood-layer', 'lclu-layer', 'populationDensity-layer', 'soilTexture-layer', 'healthCareAccess-layer'].forEach(layerId => {
        if (mapInstance.getLayer(layerId)) {
          mapInstance.removeLayer(layerId);
        }
      });
      ['water', 'flood', 'lclu', 'populationDensity', 'soilTexture', 'healthCareAccess'].forEach(sourceId => {
        if (mapInstance.getSource(sourceId)) {
          mapInstance.removeSource(sourceId);
        }
      });
      // Remove selection line
      if (mapInstance.getLayer('LineString')) {
        mapInstance.removeLayer('LineString');
      }
      if (mapInstance.getSource('LineString')) {
        mapInstance.removeSource('LineString');
      }
    }
    
    // Clear layer data
    updateLayerData({});
    
    // Reset selected grid so user needs to re-select
    setSelectedGridCords(null);
    
    // Set new data type
    setDataType(type);
    
    // Show prompt to select grid
    setActiveModal('prompt');
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

  // Get visible layers for dropdown
  const visibleLayers = Object.entries(layerVisibility)
    .filter(([_, visible]) => visible)
    .map(([name]) => ({
      name: name,
      label: getLayerLabel(name),
    }));

  return (
    <div className="panel">
      <header>
        <div className="collapse-button" onClick={handleCollapsePanel}>
          &#187;
        </div>
        <img 
          src="/static/images/Sat-GPT-Logos-01.png" 
          alt="SatGPT Logo" 
          style={{ width: '90%' }}
        />
      </header>
      
      <hr style={{ margin: '10px 0px 20px 0px' }} />

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
      {dataType === 'floodHotspot' && (
        <div id="yearControlledSlider">
          <p>Hotspot Duration</p>
          <div className="trp-range">
            <label>5 Years</label>
            <label>25 Years</label>
          </div>
          <input
            type="range"
            min="5"
            max="25"
            value={yearControl}
            onChange={(e) => setYearControl(parseInt(e.target.value))}
          />
          <span className="year-slider-value">{yearControl} Years</span>
        </div>
      )}

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
            <LayerCheckbox
              name="flood"
              label="Inundated Area"
              checked={layerVisibility.flood}
              onChange={() => handleLayerChange('flood')}
            />
            <LayerCheckbox
              name="water"
              label="Permanent Water"
              checked={layerVisibility.water}
              onChange={() => handleLayerChange('water')}
            />
            <LayerCheckbox
              name="lclu"
              label="LCLU"
              checked={layerVisibility.lclu}
              onChange={() => handleLayerChange('lclu')}
            />
            <LayerCheckbox
              name="populationDensity"
              label="Population Density"
              checked={layerVisibility.populationDensity}
              onChange={() => handleLayerChange('populationDensity')}
            />
          </div>
          <div style={{ width: '50%' }}>
            <LayerCheckbox
              name="soilTexture"
              label="Soil Texture"
              checked={layerVisibility.soilTexture}
              onChange={() => handleLayerChange('soilTexture')}
            />
            <LayerCheckbox
              name="healthCareAccess"
              label="Healthcare Access"
              checked={layerVisibility.healthCareAccess}
              onChange={() => handleLayerChange('healthCareAccess')}
            />
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

export default ControlPanel;
