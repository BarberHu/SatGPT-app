import React from 'react';
import { LANDSLIDE_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';
import DisasterLayerPanel from './DisasterLayerPanel';

function LandslidePanel() {
  return (
    <DisasterLayerPanel
      moduleName="landslide"
      moduleLabel="landslide"
      rasterLayerConfig={LANDSLIDE_RASTER_LAYER_CONFIG}
      panelClassName="landslide-panel"
      showImagery={false}
      showVector={false}
      downloadTitle="Landslide GEE code export is not connected yet"
    />
  );
}

export default LandslidePanel;
