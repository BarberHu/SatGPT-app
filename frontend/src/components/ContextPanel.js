import React from 'react';
import { CONTEXT_RASTER_LAYER_CONFIG } from '../config/agentRasterLayerConfig';
import DisasterLayerPanel from './DisasterLayerPanel';

function ContextPanel() {
  return (
    <DisasterLayerPanel
      moduleName="context"
      moduleLabel="context"
      rasterLayerConfig={CONTEXT_RASTER_LAYER_CONFIG}
      panelClassName="context-panel"
      showImagery={false}
      showVector={false}
      downloadTitle="Context GEE code export is not connected yet"
    />
  );
}

export default ContextPanel;
