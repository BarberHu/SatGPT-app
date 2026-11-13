import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LayerPanel from './LayerPanel';

test('editing temporarily collapses layers and restores the user preference without replacing layer content', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  const render = editing => root.render(<LayerPanel count={3} editing={editing}><input aria-label="Layer opacity" defaultValue="0.4" /></LayerPanel>);
  try {
    await act(async () => render(false));
    const control = node.querySelector('input'), toggle = node.querySelector('button');
    control.value = '0.7';
    await act(async () => render(true));
    expect(toggle.disabled).toBe(true); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(node.querySelector('.workspace-layer-scroll').hidden).toBe(true);
    await act(async () => render(false));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(node.querySelector('input')).toBe(control); expect(control.value).toBe('0.7');
    await act(async () => toggle.click());
    await act(async () => render(true)); await act(async () => render(false));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  } finally { await act(async () => root.unmount()); node.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; }
});
