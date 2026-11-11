import React, { useId, useState } from 'react';
import { Code2, Eye, EyeOff, ImageOff, Loader2, LocateFixed, MoreVertical, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';
import LayerLegend from './LayerLegend';
import CodeBlock from './CodeBlock';

export function Thumbnail({ layer, basic = false }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const url = layer.thumbnail?.url;
  if (!url || failedUrl === url) return <div className="agent-layer-thumbnail agent-layer-no-preview" aria-label="Static preview unavailable">
    <ImageOff size={19} strokeWidth={1.4} /><span>{url ? 'Preview unavailable' : 'No preview'}</span>
  </div>;
  return <Dialog><DialogTrigger asChild>
    <button type="button" className="agent-layer-thumbnail" aria-label={`View layer preview ${layer.name}`}>
      <img src={url} alt={`${layer.name} Static preview`} loading="lazy" onError={() => setFailedUrl(url)} />
    </button>
  </DialogTrigger><DialogContent className={`agent-preview-dialog${basic ? ' basic-preview-dialog' : ''}`}>
    <DialogTitle>{layer.name}</DialogTitle><DialogDescription>Static layer preview using the same visualization settings as the map.</DialogDescription>
    <img src={url} alt={`${layer.name} Static preview`} />
  </DialogContent></Dialog>;
}

export default function MapLayerCard({ layer, onToggle, onFocus, onRemove, onReload }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const metadata = layer.metadata || {};
  const bands = Array.isArray(layer.visualization?.bands) ? layer.visualization.bands.join(' / ') : '';
  const created = Date.parse(metadata.createdAt);
  const reload = layer.reload || {};
  const unavailable = reload.tiles === 'error';
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
    <div className="agent-layer-reload-bar">
      <span role="status">{reload.reloading ? 'Reloading from Earth Engine…' : unavailable ? 'Layer unavailable or expired' : layer.reloadedAt ? 'Layer reloaded' : ''}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => onReload?.(layer)} disabled={!layer.reloadable || reload.reloading || !onReload}
        aria-label={`Reload ${layer.name}`} title={layer.reloadable ? 'Run the original code with its saved analysis area' : layer.reloadUnavailableReason || 'Original generation parameters are unavailable'}>
        {reload.reloading ? <Loader2 size={14} className="agent-spin" /> : <RotateCw size={14} />} {reload.reloading ? 'Reloading' : 'Reload'}</Button>
    </div>
    {reload.error ? <p className="agent-layer-reload-error" role="alert">{reload.error}</p> : null}
    {expanded ? <div className="agent-layer-details" id={detailsId}>
      <dl><dt>Data source</dt><dd>{metadata.source || 'Google Earth Engine'}</dd>
        {metadata.datasetId ? <><dt>Dataset</dt><dd>{metadata.datasetId}</dd></> : null}
        <dt>Observation date</dt><dd>{metadata.observedAt || 'Not provided'}</dd>
        {Number.isFinite(created) ? <><dt>Created</dt><dd>{new Date(created).toLocaleString('en-US', { hour12: false })}</dd></> : null}
        {bands ? <><dt>Bands</dt><dd>{bands}</dd></> : null}
        {layer.bounds ? <><dt>Bounds</dt><dd>{layer.bounds.map(value => Number(value).toFixed(3)).join(', ')}</dd></> : null}
      </dl>
      {metadata.description ? <p>{metadata.description}</p> : null}
      {layer.reloadedAt ? <p>Last reloaded: {new Date(layer.reloadedAt).toLocaleString('en-US', { hour12: false })}</p> : null}
      {layer.code ? <details className="agent-layer-code"><summary><Code2 size={14} />View generation code</summary>
        <CodeBlock code={layer.code} language="python" label="GEE Python" />
      </details> : <p>Generation code is unavailable for this legacy layer.</p>}
      {!layer.reloadable ? <p>{layer.reloadUnavailableReason || 'Original generation parameters are unavailable. Run the original analysis again.'}</p> : null}
      <div className="agent-layer-actions">
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" aria-label={`Zoom to ${layer.name}`} onClick={() => onFocus(layer)}><LocateFixed size={14} />Zoom to layer</Button> : null}
        <Button type="button" variant="ghost" size="sm" className="agent-layer-remove" aria-label={`Remove ${layer.name}`} onClick={() => onRemove(layer.id)}><Trash2 size={14} />Remove layer</Button>
      </div>
    </div> : null}
  </article>;
}
