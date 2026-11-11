const assert = require('node:assert/strict');
const { test } = require('node:test');
require('sucrase/register');
const path = require('node:path');
const Module = require('node:module');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return resolveFilename.call(this, request.startsWith('@/') ? path.resolve(__dirname, '../..', request.slice(2)) : request, ...args);
};
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { chatApi } = require('../chatApi');
const { useAgentChat } = require('./useAgentChat');
const Composer = require('../components/Composer').default;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('running chats switch independently; Stop works without SSE and stale replies cannot affect another chat', async () => {
  const sources = [], cancellations = [];
  let current = 'webgis-one';
  const conversations = {
    'webgis-one': { conversation_id: 'webgis-one', messages: [], active_task: 'job-one' },
    'webgis-two': { conversation_id: 'webgis-two', messages: [], active_task: null },
  };
  chatApi.current = async () => conversations[current];
  chatApi.get = async id => conversations[id];
  chatApi.list = async () => ({ conversations: Object.keys(conversations).map(id => ({ id, title: id })) });
  chatApi.activate = async id => {
    if (!conversations[id]) throw new Error('Conversation not found');
    current = id; return conversations[id];
  };
  chatApi.create = async () => {
    current = 'webgis-three';
    conversations[current] = { conversation_id: current, messages: [], active_task: null };
    return conversations[current];
  };
  chatApi.subscribe = id => {
    const source = { id, closed: false, close() { this.closed = true; } };
    sources.push(source); return source;
  };
  chatApi.cancel = async id => {
    cancellations.push(id);
    const conversation = Object.values(conversations).find(c => c.active_task === id);
    const task = { id, conversation_id: conversation.conversation_id, status: 'cancelled', output: { message: 'Stopped by user.' } };
    conversation.active_task = null;
    conversation.messages = [{ id: `${id}-stopped`, role: 'assistant', content: 'Stopped by user.', job_id: id, status: 'cancelled' }];
    return task;
  };
  let chat;
  function Probe() {
    chat = useAgentChat();
    return React.createElement(Composer, {
      value: '', onChange() {}, onSend() {}, onStop: chat.stop,
      busy: chat.busy, pending: chat.pending, stopping: chat.stopping,
      disabled: chat.busy || chat.pending || chat.loading || chat.stopping,
      mapReady: false, stopDisabled: chat.loading,
    });
  }
  const node = document.getElementById('root');
  const root = createRoot(node);
  const emit = async (source, id, status, text = '') => React.act(async () => source.onmessage({ data: JSON.stringify({
    id, task_id: source.id, type: 'snapshot', task: { id: source.id, status,
      timeline: text ? [{ id: 'text', kind: 'text', text, committed: false }] : [] },
    answer: { attempt_id: 'attempt', status: 'streaming', text },
  }) }));
  try {
    await React.act(async () => root.render(React.createElement(Probe)));
    assert.equal(chat.busy, true, 'restored active tasks must be busy before the first stream event');
    assert.equal(node.querySelector('[aria-label="Stop response"]').disabled, false, 'Stop must work with empty input and an unavailable map');
    const firstStream = sources.at(-1);
    await emit(firstStream, 0, 'running', 'first draft');
    assert.ok(chat.items.some(item => item.text === 'first draft'));
    await React.act(async () => assert.equal(await chat.changeConversation('webgis-two'), true));
    assert.equal(firstStream.closed, true);
    assert.equal(chat.conversationId, 'webgis-two');
    assert.equal(chat.busy, false);
    await emit(firstStream, 1, 'completed', 'stale first reply');
    assert.equal(chat.items.length, 0);
    await React.act(async () => chat.changeConversation('webgis-one'));
    assert.equal(chat.busy, true);
    const resumed = sources.at(-1);
    await React.act(async () => resumed.onerror());
    assert.equal(chat.reconnecting, true);
    // No terminal SSE event is delivered. The cancel response must settle UI.
    await React.act(async () => node.querySelector('[aria-label="Stop response"]').click());
    assert.deepEqual(cancellations, ['job-one']);
    assert.equal(chat.busy, false);
    assert.equal(chat.reconnecting, false);
    assert.equal(resumed.closed, true);
    assert.equal(chat.items.at(-1).text, 'Stopped by user.');
    assert.equal(chat.items.at(-1).run.status, 'cancelled');
    assert.equal(node.querySelector('[aria-label="Stop response"]'), null);

    // A queued task can be stopped too; failed cancellation is retryable.
    conversations['webgis-two'].active_task = 'job-two';
    await React.act(async () => chat.changeConversation('webgis-two'));
    const cancel = chatApi.cancel;
    chatApi.cancel = async () => { throw new Error('Temporary stop failure'); };
    await React.act(async () => assert.equal(await chat.stop(), false));
    assert.equal(chat.busy, true);
    assert.equal(chat.stopping, false);
    assert.match(chat.error, /Temporary stop failure/);
    chatApi.cancel = cancel;
    const pendingStop = deferred();
    chatApi.cancel = () => pendingStop.promise;
    let stop;
    await React.act(async () => { stop = chat.stop(); });
    assert.equal(chat.stopping, true);
    await React.act(async () => chat.changeConversation('webgis-one'));
    await React.act(async () => pendingStop.resolve({ id: 'job-two', status: 'cancelled' }));
    assert.equal(await stop, false);
    assert.equal(chat.conversationId, 'webgis-one');
    assert.equal(chat.items.at(-1).id, 'job-one-stopped');
    assert.equal(chat.pending, false);

    // Navigation failure reattaches the old conversation's active task.
    await React.act(async () => chat.changeConversation('webgis-two'));
    const beforeFailure = sources.at(-1);
    await React.act(async () => assert.equal(await chat.changeConversation('webgis-missing'), false));
    assert.equal(beforeFailure.closed, true);
    assert.equal(chat.busy, true);
    assert.notEqual(sources.at(-1), beforeFailure);
    assert.match(chat.error, /Conversation not found/);
    // New chat remains available while another chat is running.
    await React.act(async () => assert.equal(await chat.changeConversation(), true));
    assert.equal(chat.conversationId, 'webgis-three');
    assert.equal(chat.busy, false);

    // A send accepted in another conversation must not take over the new one.
    const pendingSend = deferred();
    chatApi.send = () => pendingSend.promise;
    let send;
    await React.act(async () => { send = chat.send('a new question', [100, 10, 101, 11]); });
    assert.equal(chat.pending, true);
    await React.act(async () => chat.changeConversation('webgis-one'));
    await React.act(async () => pendingSend.resolve({ id: 'late-send', status: 'queued' }));
    assert.equal(await send, false);
    assert.equal(chat.conversationId, 'webgis-one');
    assert.equal(chat.busy, false);
    assert.equal(chat.pending, false);
    assert.equal(chat.items.at(-1).id, 'job-one-stopped');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
