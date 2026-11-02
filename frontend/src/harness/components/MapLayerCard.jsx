import React, { useId, useState } from 'react';
import { Eye, EyeOff, ImageOff, LocateFixed, MoreVertical, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';
import LayerLegend from './LayerLegend';

function Thumbnail({ layer }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const url = layer.thumbnail?.url;
  if (!url || failedUrl === url) return <div className="agent-layer-thumbnail agent-layer-no-preview" aria-label="Static preview unavailable">
    <ImageOff size={19} strokeWidth={1.4} /><span>{url ? 'Preview unavailable' : 'No preview'}</span>
  </div>;
  return <Dialog><DialogTrigger asChild>
    <button type="button" className="agent-layer-thumbnail" aria-label={`View layer preview ${layer.name}`}>
      <img src={url} alt={`${layer.name} Static preview`} loading="lazy" onError={() => setFailedUrl(url)} />
    </button>
  </DialogTrigger><DialogContent className="agent-preview-dialog">
    <DialogTitle>{layer.name}</DialogTitle><DialogDescription>Static layer preview using the same visualization settings as the map.</DialogDescription>
    <img src={url} alt={`${layer.name} Static preview`} />
  </DialogContent></Dialog>;
}

export default function MapLayerCard({ layer, onToggle, onFocus, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const metadata = layer.metadata || {};
  const bands = Array.isArray(layer.visualization?.bands) ? layer.visualization.bands.join(' / ') : '';
  const created = Date.parse(metadata.createdAt);
  return <article className={`agent-map-layer${layer.visible ? '' : ' is-hidden'}`} aria-label={`Layer ${layer.name}`}>
    <div className="agent-layer-heading">
      <Thumbnail layer={layer} />
      <div className="agent-layer-info"><strong title={layer.name}>{layer.name}</strong>
        <div className="agent-layer-meta"><span title={metadata.observedAt}>{metadata.observedAt || 'Observation date not provided'}</span>
          <span aria-hidden="true">·</span><span title={metadata.source}>{metadata.source || 'Google Earth Engine'}</span></div>
      </div>
      <LayerLegend legend={layer.legend} unit={metadata.unit} />
      <label className="agent-layer-eye" title={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}>
        <input type="checkbox" aria-label={layer.name} checked={layer.visible} onChange={event => onToggle(layer.id, event.target.checked)} />
        {layer.visible ? <Eye size={20} /> : <EyeOff size={20} />}
      </label>
      <Button type="button" variant="ghost" size="icon" className="agent-layer-more" aria-label={`Layer details ${layer.name}`}
        aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}><MoreVertical size={19} /></Button>
    </div>
    {expanded ? <div className="agent-layer-details" id={detailsId}>
      <dl><dt>Data source</dt><dd>{metadata.source || 'Google Earth Engine'}</dd>
        {metadata.datasetId ? <><dt>Dataset</dt><dd>{metadata.datasetId}</dd></> : null}
        <dt>Observation date</dt><dd>{metadata.observedAt || 'Not provided'}</dd>
        {Number.isFinite(created) ? <><dt>Created</dt><dd>{new Date(created).toLocaleString('en-US', { hour12: false })}</dd></> : null}
        {bands ? <><dt>Bands</dt><dd>{bands}</dd></> : null}
        {layer.bounds ? <><dt>Bounds</dt><dd>{layer.bounds.map(value => Number(value).toFixed(3)).join(', ')}</dd></> : null}
      </dl>
      {metadata.description ? <p>{metadata.description}</p> : null}
      <div className="agent-layer-actions">
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" aria-label={`Zoom to ${layer.name}`} onClick={() => onFocus(layer)}><LocateFixed size={14} />Zoom to layer</Button> : null}
        <Button type="button" variant="ghost" size="sm" className="agent-layer-remove" aria-label={`Remove ${layer.name}`} onClick={() => onRemove(layer.id)}><Trash2 size={14} />Remove layer</Button>
      </div>
    </div> : null}
  </article>;
}
