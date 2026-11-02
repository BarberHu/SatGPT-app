import React, { useId, useState } from 'react';
import { Eye, EyeOff, ImageOff, LocateFixed, MoreVertical, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog';
import LayerLegend from './LayerLegend';

function Thumbnail({ layer }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const url = layer.thumbnail?.url;
  if (!url || failedUrl === url) return <div className="agent-layer-thumbnail agent-layer-no-preview" aria-label="静态预览不可用">
    <ImageOff size={19} strokeWidth={1.4} /><span>{url ? '预览不可用' : '暂无预览'}</span>
  </div>;
  return <Dialog><DialogTrigger asChild>
    <button type="button" className="agent-layer-thumbnail" aria-label={`查看图层预览 ${layer.name}`}>
      <img src={url} alt={`${layer.name} 静态预览`} loading="lazy" onError={() => setFailedUrl(url)} />
    </button>
  </DialogTrigger><DialogContent className="agent-preview-dialog">
    <DialogTitle>{layer.name}</DialogTitle><DialogDescription>图层的静态预览，使用与地图相同的渲染参数。</DialogDescription>
    <img src={url} alt={`${layer.name} 静态预览`} />
  </DialogContent></Dialog>;
}

export default function MapLayerCard({ layer, onToggle, onFocus, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const metadata = layer.metadata || {};
  const bands = Array.isArray(layer.visualization?.bands) ? layer.visualization.bands.join(' / ') : '';
  const created = Date.parse(metadata.createdAt);
  return <article className={`agent-map-layer${layer.visible ? '' : ' is-hidden'}`} aria-label={`图层 ${layer.name}`}>
    <div className="agent-layer-heading">
      <Thumbnail layer={layer} />
      <div className="agent-layer-info"><strong title={layer.name}>{layer.name}</strong>
        <div className="agent-layer-meta"><span title={metadata.observedAt}>{metadata.observedAt || '观测日期未提供'}</span>
          <span aria-hidden="true">·</span><span title={metadata.source}>{metadata.source || 'Google Earth Engine'}</span></div>
      </div>
      <LayerLegend legend={layer.legend} unit={metadata.unit} />
      <label className="agent-layer-eye" title={`${layer.visible ? '隐藏' : '显示'} ${layer.name}`}>
        <input type="checkbox" aria-label={layer.name} checked={layer.visible} onChange={event => onToggle(layer.id, event.target.checked)} />
        {layer.visible ? <Eye size={20} /> : <EyeOff size={20} />}
      </label>
      <Button type="button" variant="ghost" size="icon" className="agent-layer-more" aria-label={`图层详情 ${layer.name}`}
        aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}><MoreVertical size={19} /></Button>
    </div>
    {expanded ? <div className="agent-layer-details" id={detailsId}>
      <dl><dt>数据来源</dt><dd>{metadata.source || 'Google Earth Engine'}</dd>
        {metadata.datasetId ? <><dt>数据集</dt><dd>{metadata.datasetId}</dd></> : null}
        <dt>观测日期</dt><dd>{metadata.observedAt || '未提供'}</dd>
        {Number.isFinite(created) ? <><dt>生成时间</dt><dd>{new Date(created).toLocaleString('zh-CN', { hour12: false })}</dd></> : null}
        {bands ? <><dt>波段</dt><dd>{bands}</dd></> : null}
        {layer.bounds ? <><dt>覆盖范围</dt><dd>{layer.bounds.map(value => Number(value).toFixed(3)).join(', ')}</dd></> : null}
      </dl>
      {metadata.description ? <p>{metadata.description}</p> : null}
      <div className="agent-layer-actions">
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" aria-label={`定位 ${layer.name}`} onClick={() => onFocus(layer)}><LocateFixed size={14} />定位图层</Button> : null}
        <Button type="button" variant="ghost" size="sm" className="agent-layer-remove" aria-label={`删除 ${layer.name}`} onClick={() => onRemove(layer.id)}><Trash2 size={14} />移除图层</Button>
      </div>
    </div> : null}
  </article>;
}
