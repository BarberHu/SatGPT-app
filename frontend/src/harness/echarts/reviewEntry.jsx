import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatMessage from '../components/ChatMessage';
import '../app.css';
import '../../styles/theme.css';
import './review.css';

const monthly = {
  color: ['#60a5fa', '#0f766e'],
  title: { text: 'Rainfall & flooded area', left: 16, top: 16, textStyle: { fontSize: 16 } },
  tooltip: { trigger: 'axis' },
  legend: { top: 54, left: 16, data: ['Rainfall', 'Flooded area'] },
  grid: { top: 116, bottom: 64, left: 60, right: 64, containLabel: true },
  xAxis: { type: 'category', data: ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'] },
  yAxis: [{ type: 'value', name: 'Rainfall (mm)' }, { type: 'value', name: 'Area (km²)' }],
  dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 18 }],
  series: [
    { name: 'Rainfall', type: 'bar', data: [78, 142, 215, 186, 104, 62], barMaxWidth: 32, itemStyle: { borderRadius: [4, 4, 0, 0] } },
    { name: 'Flooded area', type: 'line', yAxisIndex: 1, data: [12, 34, 68, 53, 25, 9], smooth: true, symbolSize: 7 },
  ],
};
const landCover = {
  color: ['#0f766e', '#60a5fa', '#fbbf24', '#94a3b8'],
  title: { text: 'Land cover distribution', left: 16, top: 16, textStyle: { fontSize: 16 } },
  tooltip: { trigger: 'item', formatter: '{b}: {c}% ({d}%)' },
  legend: { bottom: 16 },
  series: [{ type: 'pie', radius: ['35%', '58%'], center: ['50%', '48%'], label: { formatter: '{b}\n{d}%' },
    data: [{ name: 'Vegetation', value: 48 }, { name: 'Water', value: 22 }, { name: 'Cropland', value: 19 }, { name: 'Built-up', value: 11 }] }],
};
const fence = option => '```echarts\n' + JSON.stringify(option, null, 2) + '\n```';

function Review() {
  const [example, setExample] = useState('combined');
  const [streaming, setStreaming] = useState(false);
  const body = example === 'pie'
    ? '### Land cover composition\nSynthetic demonstration data only. These percentages are not observations from the current map.\n\n' + fence(landCover)
    : example === 'invalid'
      ? '### Invalid chart configuration\nAn invalid chart retains its original source and an explanatory error.\n\n```echarts\n{"series": [}\n```'
      : '### Monthly comparison\nSynthetic demonstration data only. May–October rainfall (mm) and flooded area (km²) illustrate a dual-axis chart; they are not actual satellite observations.\n\n' + fence(monthly) + '\nHover for values, click a legend to hide a series, or drag the lower slider to zoom.';
  return <main className="harness-app chart-review">
    <header className="chart-review-header"><div><span>SatGPT · Integration review</span><h1>Charts in conversation</h1><p>Sample data · Uses the Agent chat renderer</p></div><a href="/">Back to SatGPT</a></header>
    <nav className="chart-review-controls" aria-label="Chart examples">
      {[['combined', 'Rainfall & flood'], ['pie', 'Land cover'], ['invalid', 'Error handling']].map(([key, label]) => <button type="button" aria-pressed={example === key} key={key} onClick={() => { setExample(key); setStreaming(false); }}>{label}</button>)}
      <button type="button" aria-pressed={streaming} onClick={() => setStreaming(value => !value)}>{streaming ? 'Finish response' : 'Simulate streaming'}</button>
    </nav>
    <section className="chart-review-message"><ChatMessage message={{ role: 'assistant', text: body, streaming, layers: [], previews: [] }} /></section>
    <footer>Review baseline: 411028d · No chat history is changed by this preview.</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Review /></React.StrictMode>);
