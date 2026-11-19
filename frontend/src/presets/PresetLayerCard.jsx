import React, { useId, useState } from 'react';
import { Eye, EyeOff, LocateFixed, Trash2, ArrowUp, ArrowDown, MoreVertical } from 'lucide-react';
import LayerLegend from '../harness/components/LayerLegend';
import { Thumbnail } from '../harness/components/MapLayerCard';
import { presetById } from '../config/presetLayerCatalog';

export default function PresetLayerCard({ row, store, stale, onEdit, onFocus, first, last }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const preset = presetById(row.presetId), layer = row.layer;
  const metadata = layer?.metadata || {};
  const iconButton = (label, action, Icon, disabled = false) => <button type="button" title={label} aria-label={label} onClick={action} disabled={disabled}><Icon size={16} /></button>;
  return <article className={`preset-layer-card${row.visible ? '' : ' is-hidden'}`} aria-label={`Layer ${preset.title}`}>
    <div className="preset-layer-row">
      <Thumbnail basic layer={layer || { name: preset.title }} />
      <div className="preset-layer-name"><strong title={preset.title}>{preset.title}</strong>{preset.model ? <span className="preset-badge">Model-based index</span> : null}
        <small>{metadata.observedAt || (row.params.year_start ? `${row.params.year_start}–${row.params.year_end}` : row.params.time_start ? `${row.params.time_start} to ${row.params.time_end}` : 'Fixed dataset')}</small>
        <small title={`${metadata.source || preset.dataset} · ${row.aoi.label}`}>{metadata.source || preset.dataset} · {row.aoi.label}</small>
        {stale ? <small className="preset-stale">Different study area · retained original result</small> : null}
      </div>
      <div className="preset-legend-cell">{layer ? <LayerLegend legend={layer.legend} unit={metadata.unit} /> : <span className="preset-status" role="status">{row.status === 'loading' ? 'Generating layer…' : row.status === 'queued' ? 'Queued…' : row.status === 'empty' ? 'No rendered data' : 'Generation failed'}</span>}</div>
      <div className="preset-layer-controls">
        {iconButton(`${row.visible ? 'Hide' : 'Show'} ${preset.title}`, () => store.patch(row.id, { visible: !row.visible }), row.visible ? Eye : EyeOff)}
        <button type="button" title={`Details for ${preset.title}`} aria-label={`Details for ${preset.title}`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}><MoreVertical size={16} /></button>
      </div>
    </div>
    {row.tileStatus === 'error' || row.status === 'error' || row.status === 'empty' ? <div className="preset-layer-warning" role="status">
      <span>{row.tileStatus === 'error' ? 'Tile request failed' : row.status === 'empty' ? 'No rendered data' : 'Generation failed'}</span>
      <button type="button" onClick={() => store.retry(row.id)}>Retry</button>
    </div> : null}
    <div id={detailsId} className="preset-layer-details" hidden={!expanded}>
        <div className="preset-menu-content">
          {iconButton('Move up', () => store.move(row.id, -1), ArrowUp, first)}{iconButton('Move down', () => store.move(row.id, 1), ArrowDown, last)}
          {iconButton('Locate layer', () => onFocus(row), LocateFixed)}{iconButton('Remove layer', () => store.remove(row.id), Trash2)}
          <button type="button" onClick={() => onEdit(row)}>Edit layer</button>
          <button type="button" onClick={() => store.retry(row.id)}>Regenerate / retry</button>
        </div>
    <div className="preset-layer-footer"><label>Opacity <input type="range" min="0" max="1" step="0.05" aria-label={`Opacity for ${preset.title}`} value={row.opacity} onChange={event => store.patch(row.id, { opacity: Number(event.target.value) })} /><span>{Math.round(row.opacity * 100)}%</span></label>
      {row.status === 'ready' ? <small role="status">{row.tileStatus === 'ready' ? 'Viewport tiles ready' : row.tileStatus === 'error' ? 'Tile request failed · regenerate if expired' : 'Layer generated · waiting for tiles'}</small> : null}
    </div>
    <details className="preset-method"><summary>Source &amp; method</summary><p>{row.error || row.note}</p><p>{metadata.description || preset.infoText}</p>
      <p>{metadata.datasetId || preset.dataset}</p><p>Effective parameters: {JSON.stringify(row.effectiveParams || row.params)}</p>
      <p>Study area bounds: {Object.values(row.aoi.bounds).map(value => value.toFixed(4)).join(', ')}</p>
    </details>
    </div>
  </article>;
}
