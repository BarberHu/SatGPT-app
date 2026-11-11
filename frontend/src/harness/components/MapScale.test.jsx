import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MapScale from '../../map/MapScale';

test('ruler measures at its actual map position, updates on map moves and panel resize, then unsubscribes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.appendChild(node);
  const canvas = document.createElement('div'); const root = createRoot(node);
  let metersPerPixel = 600, bottom = 400, viewportUpdate;
  const queued = [], resized = [], unsubscribe = vi.fn();
  vi.stubGlobal('requestAnimationFrame', callback => { queued.push(callback); return queued.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { resized.push(callback); } observe() {} disconnect() {} });
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this === canvas ? { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }
      : { left: 568, right: 800, top: bottom - 32, bottom, width: 232, height: 32 };
  });
  const measure = vi.fn((start, end) => Math.abs(end[0] - start[0]) * metersPerPixel);
  const map = { ready: true, container: { current: canvas }, measureGroundDistance: measure,
    subscribeViewport: callback => { viewportUpdate = callback; return unsubscribe; } };
  try {
    await act(async () => root.render(<MapScale map={map} />));
    expect(node.querySelector('[role=img]').getAttribute('aria-label')).toBe('Map scale: 0, 25, 50, 100 km');
    expect(node.querySelectorAll('.workspace-distance-tick')).toHaveLength(4);
    expect(measure.mock.calls[0][1]).toEqual([770, 397]);
    metersPerPixel = 1;
    await act(async () => { viewportUpdate(); queued.shift()(); });
    expect(node.querySelector('[role=img]').getAttribute('aria-label')).toBe('Map scale: 0, 25, 50, 100 m');
    bottom = 320;
    await act(async () => { resized[0](); queued.shift()(); });
    expect(measure.mock.lastCall[1]).toEqual([770, 317]);
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    rect.mockRestore();vi.unstubAllGlobals();node.remove();delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
