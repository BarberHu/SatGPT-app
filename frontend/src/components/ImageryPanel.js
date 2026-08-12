import React from 'react';
import DisasterLayerPanel from './DisasterLayerPanel';

function ImageryPanel() {
  return (
    <DisasterLayerPanel
      moduleName="imagery"
      moduleLabel="imagery"
      rasterLayerConfig={[]}
      panelClassName="imagery-panel"
      showRaster={false}
      showImagery
      showVector={false}
      downloadTitle="Imagery GEE code export is not connected yet"
    />
  );
}

export default ImageryPanel;
