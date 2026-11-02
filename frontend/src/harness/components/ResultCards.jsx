import React from 'react';
import { Layers, LocateFixed } from 'lucide-react';
import AttachmentList from './AttachmentList';
import CodeBlock from './CodeBlock';
import { Button } from '../ui/button';

export default function ResultCards({ message, onFocusLayer }) {
  return <>
    <AttachmentList items={message.attachments} />
    {message.layers.length ? <div className="agent-result-layers" aria-label="地图结果">
      {message.layers.map(layer => <div className="agent-result-card" key={layer.id}>
        <Layers size={17} /><div><strong>{layer.name}</strong><small>Earth Engine · 地图图层</small></div>
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" onClick={() => onFocusLayer(layer)} aria-label={`定位 ${layer.name}`}><LocateFixed />定位</Button> : null}
      </div>)}
    </div> : null}
    {message.code ? <details className="agent-code-disclosure"><summary>查看 GEE Python 代码</summary>
      <CodeBlock code={message.code} language="python" label="GEE Python" />
    </details> : null}
  </>;
}
