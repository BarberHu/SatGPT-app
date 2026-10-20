import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import EventConfirmation from './EventConfirmation';

const context = vi.hoisted(() => ({
  selectedAOI: { id: 'aoi', bounds: { west: 118, south: 32, east: 119, north: 33 } },
  setSelectedAOI: vi.fn(),
}));
vi.mock('../context/AppContext', () => ({ useAppContext: () => context }));

test('editing dates disables confirmation until the window is valid again', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onConfirm = vi.fn();
  try {
    act(() => root.render(<EventConfirmation data={{ event: 'Test', pre_date: '2021-07-10', peek_date: '2021-07-20', after_date: '2021-07-30', recommended_layers: [{ id: 'one', title: 'One', default_selected: true }] }} onConfirm={onConfirm} onCancel={vi.fn()} />));
    const confirm = document.querySelector('.btn-confirm');
    expect(confirm.disabled).toBe(false);
    act(() => document.querySelector('[title="Edit fields"]').click());
    const pre = document.querySelector('input[type="date"]');
    const change = (value) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(pre, value);
      pre.dispatchEvent(new Event('input', { bubbles: true }));
      pre.dispatchEvent(new Event('change', { bubbles: true }));
    });
    change('2021-08-01');
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector('[role="alert"]').textContent).toContain('pre-flood ≤ peak');
    act(() => confirm.click());
    expect(onConfirm).not.toHaveBeenCalled();
    change('2021-07-10');
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ pre_date: '2021-07-10' }));
  } finally {
    act(() => root.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
