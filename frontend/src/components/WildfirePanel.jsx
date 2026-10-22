import React from 'react';
import { WILDFIRE_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';
import DisasterLayerPanel from './DisasterLayerPanel';

function WildfirePanel() {
  return (
    <DisasterLayerPanel
      moduleName="wildfire"
      moduleLabel="wildfire"
      rasterLayerConfig={WILDFIRE_RASTER_LAYER_CONFIG}
      panelClassName="wildfire-panel"
      showImagery={false}
      showVector={false}
      downloadTitle="Wildfire GEE code export is not connected yet"
    />
  );
}

export default WildfirePanel;
