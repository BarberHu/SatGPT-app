import React from 'react';
import { Camera, ChevronDown, Globe2 } from 'lucide-react';
import { Button } from '../ui/button';
import MapLayerCard from './MapLayerCard';
import MapScale from './MapScale';

export default function MapWorkspace({ map }) {
  return <section className="agent-map-workspace" aria-label="地图工作区">
    <header className="agent-map-header"><div><Globe2 size={16} /><span>地图工作区</span></div>
      <Button type="button" variant="ghost" size="icon" aria-label="保存地图截图" title="保存地图截图" onClick={map.snapshot} disabled={!map.ready}><Camera /></Button>
    </header>
    <div className="agent-map-canvas-area"><div ref={map.container} className="harness-map" aria-label="地图" />
      <div className="agent-map-context"><i />分析范围跟随地图视野</div>
      <div className="agent-map-footer"><MapScale map={map} />
      <details className="agent-map-layers" open><summary>当前图层<span className="agent-layer-count">{map.layers.length}</span><ChevronDown size={15} /></summary>
        <div className="agent-map-layer-list">{!map.layers.length ? <p>生成的图层将显示在这里</p> : map.layers.map(layer =>
          <MapLayerCard key={layer.id} layer={layer} onToggle={map.toggleLayer} onFocus={map.focusLayer} onRemove={map.removeLayer} />)}</div>
      </details>
      </div>
      {!map.configured ? <div className="agent-map-placeholder"><Globe2 size={30} /><strong>连接你的地图</strong><p>请在项目配置中填写 Mapbox token 与底图样式。</p></div> : null}
      {map.error ? <div role="alert" className="agent-map-error">{map.error}</div> : null}
    </div>
  </section>;
}
