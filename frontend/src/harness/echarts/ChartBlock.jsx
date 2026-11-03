import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import CodeBlock from '../components/CodeBlock';
import { Button } from '../ui/button';
import { parseChartOption } from './parseOption.mjs';
import './charts.css';

let enginePromise;
function loadEngine() {
  if (!enginePromise) enginePromise = import('echarts').catch(error => {
    enginePromise = undefined;
    throw error;
  });
  return enginePromise;
}

export default function ChartBlock({ code, pending = false }) {
  const host = useRef(null);
  const chart = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [renderError, setRenderError] = useState('');
  const [exportError, setExportError] = useState('');
  const parsed = useMemo(() => {
    if (pending) return {};
    try { return { option: parseChartOption(code) }; }
    catch (error) { return { error: error.message }; }
  }, [code, pending]);

  useEffect(() => {
    if (!host.current || visible) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return undefined; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    setReady(false); setRenderError(''); setExportError('');
    if (pending || !parsed.option || !visible) return undefined;
    let cancelled = false;
    let instance;
    let engine;
    let resize;
    let frame;
    const node = host.current;
    // A hidden Agent tab has no dimensions. Its ResizeObserver initializes on return.
    const draw = () => {
      if (cancelled || !engine || !node.clientWidth || !node.clientHeight) return;
      try {
        if (instance) instance.resize();
        else {
          instance = engine.init(node, null, { renderer: 'canvas' });
          chart.current = instance;
          // ECharts normalizes options in place; keep the validated input immutable.
          instance.setOption(JSON.parse(JSON.stringify(parsed.option)), { notMerge: true });
          setReady(true);
        }
      } catch (error) {
        instance?.dispose(); instance = undefined; chart.current = null;
        setReady(false); setRenderError(error.message || 'Unable to render this chart.');
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(schedule);
      resize.observe(node);
    }
    window.addEventListener('resize', schedule);
    const timeout = setTimeout(() => {
      if (!cancelled && !engine) setRenderError('Chart loading timed out. Reload the page to try again.');
    }, 15000);
    loadEngine().then(loaded => {
      if (cancelled) return;
      clearTimeout(timeout); setRenderError(''); engine = loaded; schedule();
    }).catch(error => {
      if (!cancelled) { clearTimeout(timeout); setRenderError(error.message || 'Unable to load charts.'); }
    });
    return () => {
      cancelled = true; clearTimeout(timeout); cancelAnimationFrame(frame);
      resize?.disconnect(); window.removeEventListener('resize', schedule);
      instance?.dispose(); chart.current = null;
    };
  }, [parsed, pending, visible]);

  const download = () => {
    try {
      const link = document.createElement('a');
      link.download = 'satgpt-chart.png';
      const data = chart.current.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
      const bytes = Uint8Array.from(atob(data.split(',')[1]), value => value.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      link.href = url;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError('');
    } catch { setExportError('Unable to export this chart.'); }
  };
  const error = parsed.error || renderError;
  const title = Array.isArray(parsed.option?.title) ? parsed.option.title[0]?.text : parsed.option?.title?.text;
  return <section className="agent-chart" aria-label="Interactive chart" data-chart-state={pending ? 'pending' : error ? 'error' : ready ? 'ready' : 'loading'}>
    <div className="agent-chart-header"><span>Interactive chart</span>
      <Button type="button" variant="ghost" size="sm" onClick={download} disabled={!ready || Boolean(error)} aria-label="Download chart as PNG"><Download />Save PNG</Button>
    </div>
    <div className="agent-chart-frame" hidden={Boolean(error) || pending}>
      <div ref={host} className="agent-chart-canvas" role="img" aria-label={typeof title === 'string' ? title : 'Chart of the supplied data'} />
      {!ready ? <p className="agent-chart-placeholder" role="status">Loading chart…</p> : null}
    </div>
    {pending ? <p className="agent-chart-status" role="status">The chart will appear when the response is complete.</p> : null}
    {error ? <p className="agent-chart-status agent-chart-error" role="alert">Chart unavailable: {error}</p> : null}
    {exportError ? <p className="agent-chart-status" role="alert">{exportError}</p> : null}
    {error || pending ? <CodeBlock code={code} language="echarts" /> : <details className="agent-chart-source"><summary>View chart JSON</summary><CodeBlock code={code} language="echarts" /></details>}
  </section>;
}
