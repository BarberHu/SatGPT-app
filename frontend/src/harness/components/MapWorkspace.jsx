import React from 'react';
import { Camera, ChevronDown, Globe2, Layers, LocateFixed, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';

export default function MapWorkspace({ map }) {
  return <section className="agent-map-workspace" aria-label="地图工作区">
    <header className="agent-map-header"><div><Globe2 size={16} /><span>地图工作区</span></div>
      <Button type="button" variant="ghost" size="icon" aria-label="保存地图截图" title="保存地图截图" onClick={map.snapshot} disabled={!map.ready}><Camera /></Button>
    </header>
    <div className="agent-map-canvas-area"><div ref={map.container} className="harness-map" aria-label="地图" />
      <div className="agent-map-context"><i />分析范围跟随地图视野</div>
      <details className="agent-map-layers" open><summary><Layers size={15} />地图图层<span>{map.layers.length}</span><ChevronDown size={14} /></summary>
        <div className="agent-map-layer-list">{!map.layers.length ? <p>分析生成的图层将显示在这里</p> : map.layers.map(layer => <div key={layer.id} className="agent-map-layer">
          <label><input type="checkbox" checked={layer.visible} onChange={event => map.toggleLayer(layer.id, event.target.checked)} /><span>{layer.name}</span></label>
          <div>{layer.bounds ? <Button type="button" variant="ghost" size="icon" aria-label={`定位 ${layer.name}`} onClick={() => map.focusLayer(layer)}><LocateFixed /></Button> : null}
            <Button type="button" variant="ghost" size="icon" aria-label={`删除 ${layer.name}`} onClick={() => map.removeLayer(layer.id)}><Trash2 /></Button></div>
        </div>)}</div>
      </details>
      {!map.configured ? <div className="agent-map-placeholder"><Globe2 size={30} /><strong>连接你的地图</strong><p>请在项目配置中填写 Mapbox token 与底图样式。</p></div> : null}
      {map.error ? <div role="alert" className="agent-map-error">{map.error}</div> : null}
    </div>
  </section>;
}
