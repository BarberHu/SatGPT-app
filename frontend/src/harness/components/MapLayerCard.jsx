import React, { useId, useState } from 'react';
import { Code2, Eye, EyeOff, ImageOff, Loader2, LocateFixed, MoreVertical, RotateCw, Trash2 } from 'lucide-react';
import { publicPath } from '../../utils/publicPath.js';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';
import LayerLegend from './LayerLegend';
import CodeBlock from './CodeBlock';

export function Thumbnail({ layer, basic = false }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const url = publicPath(layer.thumbnail?.url);
  if (layer.thumbnailStatus === 'pending' && !url) return <div className="agent-layer-thumbnail agent-layer-no-preview" role="status" aria-label="Generating static preview">
    <Loader2 size={19} strokeWidth={1.4} /><span>Generating preview</span>
  </div>;
  if (!url || failedUrl === url) return <div className="agent-layer-thumbnail agent-layer-no-preview" aria-label="Static preview unavailable" title="Static preview unavailable">
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
  const osm = Boolean(layer.dataUrl);
  const dataTime = metadata.observedAt || (osm ? 'OSM data time unavailable' : 'Observation date not provided');
  const bands = Array.isArray(layer.visualization?.bands) ? layer.visualization.bands.join(' / ') : '';
  const created = Date.parse(metadata.createdAt);
  const reload = layer.reload || {};
  const unavailable = reload.tiles === 'error';
  const reloadAction = <Button type="button" variant="ghost" size="sm" onClick={() => onReload?.(layer)} disabled={!layer.reloadable || reload.reloading || !onReload}
    aria-label={`Reload ${layer.name}`} title={layer.reloadable ? 'Run the original code with its saved analysis area' : layer.reloadUnavailableReason || 'Original generation parameters are unavailable'}>
    {reload.reloading ? <Loader2 size={14} className="agent-spin" /> : <RotateCw size={14} />} {reload.reloading ? 'Reloading' : 'Reload'}</Button>;
  const urgentReload = unavailable || reload.reloading || Boolean(reload.error);
  return <article className={`agent-map-layer${layer.visible ? '' : ' is-hidden'}`} aria-label={`Layer ${layer.name}`}>
    <div className="agent-layer-heading">
      {osm ? null : <Thumbnail layer={layer} />}
      <div className="agent-layer-info" style={osm ? { gridColumn: '1 / 3' } : undefined}><strong title={layer.name}>{layer.name}</strong>
        <div className="agent-layer-meta"><span title={metadata.observedAt}>{dataTime}</span>
          <span aria-hidden="true">·</span><span title={metadata.source}>{metadata.source || 'Google Earth Engine'}</span></div>
      </div>
      {osm ? null : <LayerLegend legend={layer.legend} unit={metadata.unit} />}
      <label className="agent-layer-eye" title={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}>
        <input type="checkbox" aria-label={layer.name} checked={layer.visible} onChange={event => onToggle(layer.id, event.target.checked)} />
        {layer.visible ? <Eye size={20} /> : <EyeOff size={20} />}
      </label>
      <Button type="button" variant="ghost" size="icon" className="agent-layer-more" aria-label={`Layer details ${layer.name}`}
        aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}><MoreVertical size={19} /></Button>
    </div>
    {osm && unavailable ? <p className="agent-layer-reload-error" role="alert">Unable to load the OpenStreetMap layer.</p> : null}
    {!osm && urgentReload ? <div className="agent-layer-reload-bar">
      <span role="status">{reload.reloading ? 'Reloading from Earth Engine…' : unavailable ? 'Layer unavailable or expired' : layer.reloadedAt ? 'Layer reloaded' : ''}</span>
      {reloadAction}
    </div> : null}
    {reload.error ? <p className="agent-layer-reload-error" role="alert">{reload.error}</p> : null}
    {expanded ? <div className="agent-layer-details" id={detailsId}>
      <dl><dt>Data source</dt><dd>{metadata.source || 'Google Earth Engine'}</dd>
        {metadata.datasetId ? <><dt>Dataset</dt><dd>{metadata.datasetId}</dd></> : null}
        <dt>{osm ? 'OSM data time' : 'Observation date'}</dt><dd>{metadata.observedAt || 'Not provided'}</dd>
        {Number.isFinite(created) ? <><dt>Created</dt><dd>{new Date(created).toLocaleString('en-US', { hour12: false })}</dd></> : null}
        {bands ? <><dt>Bands</dt><dd>{bands}</dd></> : null}
        {layer.bounds ? <><dt>Bounds</dt><dd>{layer.bounds.map(value => Number(value).toFixed(3)).join(', ')}</dd></> : null}
      </dl>
      {metadata.description ? <p>{metadata.description}</p> : null}
      {layer.reloadedAt ? <p>Last reloaded: {new Date(layer.reloadedAt).toLocaleString('en-US', { hour12: false })}</p> : null}
      {layer.code ? <details className="agent-layer-code"><summary><Code2 size={14} />View generation code</summary>
        <CodeBlock code={layer.code} language="python" label="GEE Python" />
      </details> : osm ? null : <p>Generation code is unavailable for this legacy layer.</p>}
      {!osm && !layer.reloadable ? <p>{layer.reloadUnavailableReason || 'Original generation parameters are unavailable. Run the original analysis again.'}</p> : null}
      <div className="agent-layer-actions">
        {!osm && !urgentReload ? reloadAction : null}
        {osm ? <Button asChild variant="ghost" size="sm"><a href={publicPath(layer.dataUrl)} download>Download GeoJSON</a></Button> : null}
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" aria-label={`Zoom to ${layer.name}`} onClick={() => onFocus(layer)}><LocateFixed size={14} />Zoom to layer</Button> : null}
        <Button type="button" variant="ghost" size="sm" className="agent-layer-remove" aria-label={`Remove ${layer.name}`} onClick={() => onRemove(layer.id)}><Trash2 size={14} />Remove layer</Button>
      </div>
    </div> : null}
  </article>;
}
