import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import Composer from './Composer';
import Markdown from './Markdown';
import MessageList from './MessageList';
import { chatViewModel } from '../chatViewModel';

let root, node;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

test('composer supports Enter, Shift+Enter, IME composition and running state without upload controls', async () => {
  const send = vi.fn();
  await act(async () => root.render(<Composer value={'hello\nworld'} onChange={() => {}} onSend={send} mapReady />));
  const input = node.querySelector('textarea');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  expect(send).not.toHaveBeenCalled();
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).toHaveBeenCalledTimes(1);
  expect(node.querySelector('input[type=file]')).toBeNull();
  const stop = vi.fn();
  await act(async () => root.render(<Composer value="" onChange={() => {}} onSend={send} onStop={stop} busy disabled />));
  expect(node.querySelector('[aria-label="Stop response"]').disabled).toBe(false);
  expect(node.querySelector('[aria-label="Stop response"]').getAttribute('aria-label')).toBe('Stop response');
  await act(async () => node.querySelector('[aria-label="Stop response"]').click());
  expect(stop).toHaveBeenCalledTimes(1);
});

test('composer explains when a model offers only its default and still allows sending', async () => {
  const send = vi.fn(), retry = vi.fn();
  await act(async () => root.render(<Composer value="Use the default" onSend={send} mapReady
    reasoning={{ model: 'Plain model', levels: [], status: 'ready' }} reasoningEffort="" onReasoningRetry={retry} />));
  await act(async () => node.querySelector('.agent-reasoning-trigger').click());
  const panel = node.querySelector('.agent-reasoning-panel');
  expect(panel.textContent).toBe('This model uses the server default.');
  expect(panel.querySelector('button')).toBeNull();
  await act(async () => node.querySelector('button[type=submit]').click());
  expect(send).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
});

test('composer shows the current analysis area and prevents sending during edits', async () => {
  const send = vi.fn(), edit = vi.fn(), clear = vi.fn(), cancel = vi.fn();
  const triangle = { type: 'Polygon', coordinates: [[[0, 0], [.01, 0], [0, .01], [0, 0]]] };
  const render = region => act(async () => root.render(<Composer value="Analyze this area" onChange={() => {}} onSend={send} mapReady
    region={{ ready: true, clear, cancel, ...region }} onEditRegion={edit} />));
  const area = () => node.querySelector('[aria-label="Analysis area"]');
  await render({});
  expect(area().textContent).toContain('Current map view');
  await render({ confirmed: triangle });
  expect(node.querySelectorAll('[aria-label="Analysis area"]')).toHaveLength(1);
  expect(node.querySelector('textarea').compareDocumentPosition(area()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(area().querySelector('[role="status"]').textContent).toMatch(/^Area 1 ·/);
  await act(async () => area().querySelector('[aria-label="Edit analysis area"]').click());
  await act(async () => area().querySelector('[aria-label="Clear analysis area"]').click());
  expect(edit).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  await render({ editing: true });
  expect(area().textContent).toContain('Drawing polygon…');
  expect(area().querySelector('[aria-label="Edit analysis area"]')).toBeNull();
  expect(node.querySelector('button[type="submit"]').disabled).toBe(true);
  await act(async () => node.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).not.toHaveBeenCalled();
  await render({ editing: true, canConfirm: true });
  expect(area().textContent).toContain('Confirm area on map');
  await act(async () => area().querySelector('[aria-label="Cancel area editing"]').click());
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('Streamdown renders partial code fences, lists and GFM tables while streaming', async () => {
  await act(async () => root.render(<Markdown streaming text={'1. first\n2. second\n\n| Data | Value |\n| --- | --- |\n| Rain | 3 |\n\n```python\nresult = ee.Number(1)'} />));
  expect(node.querySelectorAll('ol li')).toHaveLength(2);
  expect(node.querySelector('table').textContent).toContain('Rain');
  expect(node.querySelector('pre code').textContent).toContain('result = ee.Number(1)');
  await act(async () => root.render(<Markdown text={'```python\nresult = ee.Number(2)\n```'} />));
  expect(node.querySelectorAll('pre')).toHaveLength(1);
  expect(node.textContent).not.toContain('ee.Number(1)');
  expect(node.querySelector('pre code').textContent).toBe('result = ee.Number(2)');
});

test('message scrolling follows only near the bottom and offers an explicit jump', async () => {
  const item = text => ({ id: 'message', role: 'assistant', text, steps: [], layers: [], attachments: [], code: '', streaming: true });
  await act(async () => root.render(<MessageList items={[item('first')]} onFocusLayer={() => {}} />));
  const scroll = node.querySelector('[role=log]');
  Object.defineProperty(scroll, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
  scroll.scrollTop = 200;
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => root.render(<MessageList items={[item('second delta')]} onFocusLayer={() => {}} />));
  expect(scroll.scrollTop).toBe(200);
  expect(node.textContent).toContain('Jump to latest');
  await act(async () => node.querySelector('.agent-jump').click());
  expect(scroll.scrollTop).toBe(2000);
  await act(async () => root.render(<MessageList items={[item('third delta')]} onFocusLayer={() => {}} />));
  expect(scroll.scrollTop).toBe(2000);
  // An upward gesture disables following even within the 96px bottom zone.
  scroll.scrollTop = 1490;
  await act(async () => scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, bubbles: true })));
  await act(async () => scroll.dispatchEvent(new Event('scroll', { bubbles: true })));
  await act(async () => root.render(<MessageList items={[item('fourth delta')]} onFocusLayer={() => {}} />));
  expect(scroll.scrollTop).toBe(1490);
  expect(node.textContent).toContain('Jump to latest');
});

test('view model keeps committed reasoning separate from final answer', () => {
  const model = chatViewModel([{ id: 'm', role: 'assistant', content: 'body', job_id: 'job',
    timeline: [{ id: 'reason', seq: 1, kind: 'reasoning', text: 'model thought', committed: true },
      { id: 'tool', seq: 2, kind: 'tool', name: 'gee_eval', arguments: 'params', result: 'result', status: 'done', committed: true }],
    code: 'result = 1', previews: [{ url: '/api/previews/p.png' }], layers: [{ name: 'layer' }],
  }], { id: 'job', status: 'completed', output: { message: 'body' } }, null);
  expect(model.items).toHaveLength(1);
  expect(model.items[0].text).toBe('body');
  expect(model.items[0].timeline.map(row => row.kind)).toEqual(['reasoning', 'tool']);
  expect(model.items[0].timeline[1].arguments).toBe('params');
  expect(model.items[0].timeline[0].text).toBe('model thought');
  expect(model.items[0].text).not.toContain('model thought');
  expect(model.items[0].attachments[0].type).toBe('image');
  expect(model.items[0].layers[0].id).toBe('job-0');
});

test('live reasoning appears as a collapsed row in the open unified run', async () => {
  const { default: ChatMessage } = await import('./ChatMessage');
  await act(async () => root.render(<ChatMessage message={{ id: 'task', role: 'assistant', text: 'answer',
    pending: true, timeline: [{ id: 'r', kind: 'reasoning', text: 'thinking live', streaming: true }],
    steps: [], attachments: [], layers: [], streaming: true }} />));
  const panel = node.querySelector('[aria-label="Run timeline"]');
  expect(panel.open).toBe(true);
  expect(panel.textContent).toContain('thinking live');
  expect(node.querySelector('[data-kind="reasoning"]').open).toBe(false);
  expect(node.querySelector('.agent-markdown').textContent).toBe('answer');
});
