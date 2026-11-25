import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { chatViewModel } from '../chatViewModel';
import TaskProgress from './TaskProgress';

test('long waits update in place across tool calls and reset on a visible update', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-22T15:00:00Z'));
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const task = { id: 'job', status: 'queued', created_at: new Date().toISOString(), timeline: [] };
  const render = (patch = {}, options = {}) => act(async () => {
    const { activity } = chatViewModel([], { ...task, ...patch });
    root.render(activity && <TaskProgress key={activity.id} activity={activity} {...options} />);
  });
  const advance = ms => act(async () => { vi.advanceTimersByTime(ms); });
  const tool = { id: 'tool', kind: 'tool', name: 'gee_eval', status: 'running' };
  const notice = { id: 'text', kind: 'text', text: 'The mask is valid.', attempt_id: 'phase', committed: false };
  const progress = () => node.querySelector('.agent-task-progress');
  const status = () => progress()?.querySelector('[role="status"]')?.textContent;
  try {
    await render();
    expect(status()).toBe('Waiting in the queue');
    const bar = progress();
    await advance(20_000);
    await render({ status: 'running', timeline: [tool] });
    expect(status()).toBe('Running an Earth Engine query');
    await advance(9999);
    expect(progress().querySelector('.agent-task-progress-time')).toBeNull();
    await advance(1);
    expect(progress()).toBe(bar);
    expect(status()).toBe('Still working · Running an Earth Engine query');
    expect(progress().querySelector('[aria-hidden="true"].agent-task-progress-time').textContent).toBe('· 30s elapsed');
    await advance(2000);
    expect(status()).toBe('Still working · Running an Earth Engine query');
    expect(progress().textContent).toContain('32s elapsed');
    await render({ status: 'running', timeline: [{ ...tool, status: 'error' }] });
    expect(status()).toBe('Still working · Analyzing');
    await render({ status: 'running', timeline: [{ ...tool, status: 'error' }, { ...tool, id: 'retry' }] });
    expect(status()).toBe('Still working · Running an Earth Engine query');
    await render({ status: 'running', timeline: [notice, tool] });
    expect(progress()).toBe(bar);
    expect(status()).toBe('Running an Earth Engine query');
    await advance(20_000);
    await render({ status: 'running', timeline: [{ ...notice, text: 'The mask is valid. Checking coverage.' }, tool] });
    await advance(10_000);
    expect(status()).toBe('Still working · Running an Earth Engine query');
    await render({ status: 'running', timeline: [notice, tool] }, { reconnecting: true });
    expect(status()).toBe('Reconnecting…');
    await render({ status: 'cancelling', timeline: [notice, tool] }, { reconnecting: true });
    expect(status()).toBe('Stopping…');
    await render({ status: 'cancelled' });
    expect(progress()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.useRealTimers();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
