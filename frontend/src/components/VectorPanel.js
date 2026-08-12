import React from 'react';
import DisasterLayerPanel from './DisasterLayerPanel';

function VectorPanel() {
  return (
    <DisasterLayerPanel
      moduleName="vector"
      moduleLabel="vector"
      rasterLayerConfig={[]}
      panelClassName="vector-panel"
      showRaster={false}
      showImagery={false}
      showVector
      downloadTitle="Vector GEE code export is not connected yet"
    />
  );
}

export default VectorPanel;
