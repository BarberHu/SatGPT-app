import React from 'react';

const number = value => new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 5 }).format(value);
export default function LayerLegend({ legend, unit }) {
  if (!legend || legend.type === 'unavailable') return <p className="agent-layer-legend-missing">未提供图例参数</p>;
  return <div className="agent-layer-legend" aria-label="图例">
    <span className="agent-layer-legend-title">图例{unit ? ` · ${unit}` : ''}</span>
    {legend.type === 'continuous' ? <div className="agent-layer-scale">
      <div className="agent-layer-colorbar" role="img"
        aria-label={legend.min === null ? '色带，数值范围未提供' : `色带，从 ${number(legend.min)} 到 ${number(legend.max)}${unit ? ` ${unit}` : ''}`}
        style={{ background: legend.colors.length === 1 ? legend.colors[0] : `linear-gradient(to right, ${legend.colors.join(', ')})` }} />
      {legend.min !== null ? <div className="agent-layer-scale-labels"><span>{number(legend.min)}</span><span>{number(legend.max)}</span></div>
        : <small>数值范围未提供</small>}
    </div> : legend.type === 'categorical' ? <ul className="agent-layer-categories">
      {legend.items.map((item, index) => <li key={index}><span className="agent-layer-swatch" style={{ backgroundColor: item.color }} />
        <span>{item.label}</span><small>{number(item.value)}</small></li>)}
    </ul> : <div className="agent-layer-rgb">RGB 合成<span>{legend.bands.map((band, i) => `${['R', 'G', 'B'][i]}: ${band}`).join(' · ')}</span></div>}
  </div>;
}
