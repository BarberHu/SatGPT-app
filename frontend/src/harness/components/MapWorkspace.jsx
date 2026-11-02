import React from 'react';
import { ChevronDown, Globe2 } from 'lucide-react';
import MapLayerCard from './MapLayerCard';
import { SharedMapViewport } from '../../map/SharedMapContext';

export default function MapWorkspace({ map, active = true }) {
  return <section className="agent-map-workspace" aria-label="Map workspace">
    <div className="agent-map-canvas-area"><SharedMapViewport active={active} />
      <div className="agent-map-context"><i />Analysis uses the current map extent</div>
      <div className="agent-map-footer">
      <details className="agent-map-layers" open><summary>Current layers<span className="agent-layer-count">{map.layers.length}</span><ChevronDown size={15} /></summary>
        <div className="agent-map-layer-list">{!map.layers.length ? <p>Generated layers will appear here</p> : map.layers.map(layer =>
          <MapLayerCard key={layer.id} layer={layer} onToggle={map.toggleLayer} onFocus={map.focusLayer} onRemove={map.removeLayer} />)}</div>
      </details>
      </div>
      {!map.configured ? <div className="agent-map-placeholder"><Globe2 size={30} /><strong>Connect your map</strong><p>Set the Mapbox token and basemap style in the project configuration.</p></div> : null}
      {map.error ? <div role="alert" className="agent-map-error">{map.error}</div> : null}
    </div>
  </section>;
}
