import React from 'react';
import { Layers, LocateFixed } from 'lucide-react';
import AttachmentList from './AttachmentList';
import CodeBlock from './CodeBlock';
import { Button } from '../ui/button';

export default function ResultCards({ message, onFocusLayer }) {
  return <>
    <AttachmentList items={message.attachments} />
    {message.layers.length ? <div className="agent-result-layers" aria-label="Map results">
      {message.layers.map(layer => <div className="agent-result-card" key={layer.id}>
        <Layers size={17} /><div><strong>{layer.name}</strong><small>Earth Engine · Map layer</small></div>
        {layer.bounds ? <Button type="button" variant="ghost" size="sm" onClick={() => onFocusLayer(layer)} aria-label={`Zoom to ${layer.name}`}><LocateFixed />Zoom to</Button> : null}
      </div>)}
    </div> : null}
    {message.code ? <details className="agent-code-disclosure"><summary>View GEE Python code</summary>
      <CodeBlock code={message.code} language="python" label="GEE Python" />
    </details> : null}
  </>;
}
