import React from 'react';
import { useAppContext } from '../context/AppContext';

function Legends() {
  const { layerVisibility, dataType } = useAppContext();

  return (
    <>
      {/* Population, Health, Soil Container */}
      {(layerVisibility.populationDensity || 
        layerVisibility.healthCareAccess || 
        layerVisibility.soilTexture) && (
        <div className="population-health-soil-container" id="populationHealthSoilContainer">
          {layerVisibility.soilTexture && <SoilTextureLegend />}
          {layerVisibility.healthCareAccess && <HealthCareAccessLegend />}
          {layerVisibility.populationDensity && <PopulationDensityLegend />}
        </div>
      )}

      {/* LCLU and Color Range Panel */}
      <div className="lclu-color-range-container">
        {layerVisibility.lclu && <LCLULegend />}
        {dataType === 'floodHotspot' && <ColorRangeLegend />}
      </div>
    </>
  );
}

function SoilTextureLegend() {
  const soilTypes = [
    { color: '#d5c36b', label: 'Cl' },
    { color: '#b96947', label: 'SiCl' },
    { color: '#9d3706', label: 'SaCl' },
    { color: '#ae868f', label: 'ClLo' },
    { color: '#f86714', label: 'SiClLo' },
    { color: '#46d143', label: 'SaClLo' },
    { color: '#368f20', label: 'Lo' },
    { color: '#3e5a14', label: 'SiLo' },
    { color: '#ffd557', label: 'SaLo' },
    { color: '#fff72e', label: 'Si' },
    { color: '#ff5a9d', label: 'LoSa' },
    { color: '#ff005b', label: 'Sa' },
  ];

  return (
    <div id="soilTexturePanel" className="soil-texture-panel">
      <p><b>Soil Texture</b></p>
      {soilTypes.map((soil, index) => (
        <div key={index} className="soil-texture-container">
          <div className="color-box" style={{ backgroundColor: soil.color }}></div>
          <span>{soil.label}</span>
        </div>
      ))}
    </div>
  );
}

function HealthCareAccessLegend() {
  return (
    <div id="healthCareAccessContainer" className="healthcare-access-container">
      <p><b>Healthcare Accessibility (min)</b></p>
      &gt;1000
      <div id="healthCareAccessGradient"></div>
      0
    </div>
  );
}

function PopulationDensityLegend() {
  return (
    <div id="populationDensityContainer" className="population-density-container">
      <p><b>Population Density</b></p>
      &gt;1000
      <div id="populationDensityGradient"></div>
      0
    </div>
  );
}

function LCLULegend() {
  const lcluTypes = [
    { color: '#006400', label: 'Tree cover' },
    { color: '#ffbb22', label: 'Shrubland' },
    { color: '#ffff4c', label: 'Grassland' },
    { color: '#f096ff', label: 'Cropland' },
    { color: '#fa0000', label: 'Built-up' },
    { color: '#b4b4b4', label: 'Bare/sparse vegetation' },
    { color: '#f0f0f0', label: 'Snow and ice' },
    { color: '#0064c8', label: 'Permanent water bodies' },
    { color: '#0096a0', label: 'Herbaceous wetland' },
    { color: '#00cf75', label: 'Mangroves' },
    { color: '#fae6a0', label: 'Moss and lichen' },
  ];

  return (
    <div id="lcluPanel" className="lclu-panel">
      <p><b>LCLU</b></p>
      {lcluTypes.map((lclu, index) => (
        <div key={index} className="lclu-container">
          <div className="color-box" style={{ backgroundColor: lclu.color }}></div>
          <span>{lclu.label}</span>
        </div>
      ))}
    </div>
  );
}

function ColorRangeLegend() {
  const colorRanges = [
    { color: '#ffa9bb', label: '<10%' },
    { color: '#ff9cac', label: '10-20%' },
    { color: '#ff8f9e', label: '20-30%' },
    { color: '#ff8190', label: '30-40%' },
    { color: '#ff7281', label: '40-50%' },
    { color: '#ff6171', label: '50-60%' },
    { color: '#ff4f61', label: '60-70%' },
    { color: '#ff3b50', label: '70-80%' },
    { color: '#ff084a', label: '>80%' },
    { color: '#00008B', label: 'Permanent Water' },
  ];

  return (
    <div id="colorRangePanel" className="color-range-panel">
      <p><b>Inundation Hotspots (%)</b></p>
      {colorRanges.map((range, index) => (
        <div key={index} className="color-range-container">
          <div className="color-box" style={{ backgroundColor: range.color }}></div>
          <span>{range.label}</span>
        </div>
      ))}
    </div>
  );
}

export default Legends;
