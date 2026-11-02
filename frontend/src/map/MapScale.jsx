import React, { useEffect, useRef, useState } from 'react';
import { distanceScale } from './distanceScale';

/** Engine-independent ruler aligned with its real screen position on the map. */
export default function MapScale({ map }) {
  const ruler = useRef(null);
  const [scale, setScale] = useState(null);
  useEffect(() => {
    if (!map.ready || !ruler.current || !map.container.current || !map.measureGroundDistance) return undefined;
    let frame = null;
    let disposed = false;
    const update = () => {
      frame = null;
      if (disposed) return;
      const canvas = map.container.current?.getBoundingClientRect();
      const box = ruler.current?.getBoundingClientRect();
      if (!canvas?.width || !box?.width) { setScale(null); return; }
      const width = Math.min(192, box.width - 40);
      const right = box.right - canvas.left - 30;
      const y = box.bottom - canvas.top - 3;
      try {
        setScale(distanceScale(pixels => map.measureGroundDistance([right - pixels, y], [right, y]), width));
      } catch { setScale(null); }
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const unsubscribe = map.subscribeViewport?.(schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(map.container.current);
    if (ruler.current.parentElement) observer?.observe(ruler.current.parentElement);
    update();
    return () => { disposed = true; if (frame !== null) cancelAnimationFrame(frame); observer?.disconnect(); unsubscribe?.(); };
  }, [map.ready, map.container, map.measureGroundDistance, map.subscribeViewport]);
  if (!map.ready) return null;
  const description = scale ? `Map scale: ${scale.ticks.map(tick => tick.label).join(', ')} ${scale.unit}` : undefined;
  return <div ref={ruler} className="workspace-distance-scale" role="img" aria-label={description}
    aria-hidden={scale ? undefined : true} style={{ visibility: scale ? 'visible' : 'hidden' }}>
    {scale ? <div className="workspace-distance-axis" style={{ width: `${scale.width}px` }} aria-hidden="true">
      {scale.ticks.map((tick, index) => <span key={tick.fraction} className="workspace-distance-tick" style={{ left: `${tick.fraction * 100}%` }}>
        <span>{tick.label}{index === scale.ticks.length - 1 ? ` ${scale.unit}` : ''}</span>
      </span>)}
    </div> : null}
  </div>;
}
