import React from 'react';
import { ChevronDown, Globe2 } from 'lucide-react';
import MapLayerCard from './MapLayerCard';
import { SharedMapViewport } from '../../map/SharedMapContext';
import { Button } from '../ui/button';

export default function MapWorkspace({ map, region, onConfirmRegion, active = true }) {
  return <section className="agent-map-workspace" aria-label="Map workspace">
    <div className="agent-map-canvas-area"><SharedMapViewport active={active} />
      <div className="agent-map-context"><i />{region?.confirmed ? 'Confirmed analysis polygon' : 'Analysis uses the current map extent'}</div>
      {region?.editing ? <div className="agent-region-tools" role="group" aria-label="Draw analysis area">
        <p role="status">{region.canConfirm ? 'Drag vertices to edit. Confirm when ready.' : 'Click to add vertices. Double-click the last vertex to finish.'}</p>
        {region.error ? <p role="alert">{region.error}</p> : null}
        <div><Button type="button" size="sm" disabled={!region.canConfirm} onClick={onConfirmRegion}>Use this area</Button>
          <Button type="button" size="sm" variant="secondary" onClick={region.cancel}>Cancel</Button></div>
      </div> : null}
      <div className="agent-map-footer">
      <details className="agent-map-layers" open><summary>Current layers<span className="agent-layer-count">{map.layers.length}</span><ChevronDown size={15} /></summary>
        <div className="agent-map-layer-list">{!map.layers.length ? <p>Generated layers will appear here</p> : map.layers.map(layer =>
          <MapLayerCard key={layer.id} layer={layer} onToggle={map.toggleLayer} onFocus={map.focusLayer} onRemove={map.removeLayer} onReload={map.reloadLayer} />)}</div>
      </details>
      </div>
      {!map.configured ? <div className="agent-map-placeholder"><Globe2 size={30} /><strong>Connect your map</strong><p>Set the Mapbox token and basemap style in the project configuration.</p></div> : null}
      {map.error ? <div role="alert" className="agent-map-error">{map.error}</div> : null}
    </div>
  </section>;
}
