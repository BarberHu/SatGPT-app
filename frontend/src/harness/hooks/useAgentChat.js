import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from '../chatApi';
import { emptyStream, receiveStream } from '../streamState';
import { chatViewModel } from '../chatViewModel';

export function useAgentChat() {
  const [conversation, setConversation] = useState({ conversation_id: null, messages: [] });
  const [conversations, setConversations] = useState([]);
  const [task, setTask] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const source = useRef(null);
  const generation = useRef(0);
  const request = useRef(null);
  const watch = useRef(null);
  const conversationId = useRef(null);
  const alive = useRef(false);
  const action = useRef(false);

  const refreshList = useCallback(async (signal) => {
    const data = await chatApi.list(signal);
    if (alive.current && !signal?.aborted) setConversations(data.conversations || []);
  }, []);

  const load = useCallback(async (epoch, signal, id) => {
    const data = id ? await chatApi.get(id, signal) : await chatApi.current(signal);
    if (!alive.current || epoch !== generation.current || signal?.aborted) return null;
    conversationId.current = data.conversation_id;
    setConversation(data);
    return data;
  }, []);

  watch.current = (id) => {
    source.current?.close();
    const stream = chatApi.subscribe(id);
    source.current = stream;
    const epoch = generation.current;
    let state = emptyStream(id);
    setTask({ id, conversation_id: conversationId.current, status: 'queued' });
    setAnswer(null);
    setReconnecting(false);
    stream.onopen = () => { if (source.current === stream) setReconnecting(false); };
    stream.onerror = () => { if (source.current === stream) setReconnecting(true); };
    stream.onmessage = async event => {
      if (!alive.current || source.current !== stream || epoch !== generation.current) return;
      try {
        state = receiveStream(state, JSON.parse(event.data));
        if (!state.task) return;
        setTask(state.task);
        setAnswer(state.answer);
        if (['completed', 'failed', 'cancelled'].includes(state.task.status)) {
          stream.close();
          source.current = null;
          setReconnecting(false);
          const signal = request.current?.signal;
          await load(epoch, signal, conversationId.current);
          if (!alive.current || epoch !== generation.current) return;
          await refreshList(signal);
        }
      } catch (cause) {
        if (alive.current && epoch === generation.current && cause.name !== 'AbortError') setError(cause.message);
      }
    };
  };

  useEffect(() => {
    alive.current = true;
    const epoch = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    (async () => {
      try {
        const data = await load(epoch, controller.signal);
        if (data?.active_task) watch.current(data.active_task);
        await refreshList(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
      generation.current++;
      controller.abort();
      request.current?.abort();
      source.current?.close();
      source.current = null;
    };
  }, [load, refreshList]);

  const changeConversation = useCallback(async (id) => {
    if (id && id === conversationId.current && !loading) return true;
    const previousId = conversationId.current;
    setLoading(true);
    setPending(false);
    setStopping(false);
    action.current = false;
    setError('');
    const epoch = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    source.current?.close();
    source.current = null;
    try {
      const data = id ? await chatApi.activate(id, controller.signal) : await chatApi.create(controller.signal);
      if (!alive.current || epoch !== generation.current) return false;
      conversationId.current = data.conversation_id;
      setConversation(data);
      setTask(null);
      setAnswer(null);
      setReconnecting(false);
      if (data.active_task) watch.current(data.active_task);
      await refreshList(controller.signal);
      return alive.current && epoch === generation.current;
    } catch (cause) {
      if (alive.current && epoch === generation.current && !controller.signal.aborted) {
        setError(cause.message);
        // A failed switch must leave the previous running chat connected.
        try {
          const data = await load(epoch, controller.signal, previousId);
          if (data?.active_task) watch.current(data.active_task);
        } catch { /* Keep the original navigation error visible. */ }
      }
      return false;
    } finally {
      if (alive.current && epoch === generation.current) setLoading(false);
    }
  }, [load, loading, refreshList]);

  const send = useCallback(async (prompt, bounds) => {
    if (action.current || pending || loading || ['queued', 'running'].includes(task?.status)) return false;
    action.current = true;
    setPending(true);
    setError('');
    const epoch = generation.current;
    const signal = request.current?.signal;
    const id = conversationId.current;
    try {
      const next = await chatApi.send({ prompt, bounds, conversation_id: id }, signal);
      if (!alive.current || epoch !== generation.current) return false;
      setTask(next);
      await load(epoch, signal, id);
      if (!alive.current || epoch !== generation.current) return false;
      watch.current(next.id);
      return true;
    } catch (cause) {
      if (alive.current && epoch === generation.current && cause.name !== 'AbortError') setError(cause.message);
      return false;
    } finally {
      if (alive.current && epoch === generation.current) {
        action.current = false;
        setPending(false);
      }
    }
  }, [pending, loading, task?.status, load]);

  const stop = useCallback(async () => {
    if (action.current || loading || stopping || !['queued', 'running'].includes(task?.status)) return false;
    const epoch = generation.current;
    const id = conversationId.current;
    const signal = request.current?.signal;
    action.current = true;
    setStopping(true);
    setError('');
    try {
      const stopped = await chatApi.cancel(task.id, signal);
      if (!alive.current || epoch !== generation.current) return false;
      // The response also completes Stop if the event stream is disconnected.
      if (['completed', 'failed', 'cancelled'].includes(stopped.status)) {
        source.current?.close();
        source.current = null;
        setTask(stopped);
        setAnswer(null);
        setReconnecting(false);
        await load(epoch, signal, id);
        if (alive.current && epoch === generation.current) await refreshList(signal);
      }
      return true;
    } catch (cause) {
      if (alive.current && epoch === generation.current && cause.name !== 'AbortError') setError(cause.message);
      return false;
    } finally {
      if (alive.current && epoch === generation.current) {
        action.current = false;
        setStopping(false);
      }
    }
  }, [loading, stopping, task?.id, task?.status, load, refreshList]);

  const view = useMemo(() => chatViewModel(conversation.messages, task, answer), [conversation.messages, task, answer]);
  return { ...view, conversationId: conversation.conversation_id, messages: conversation.messages,
    conversations, loading, pending, stopping, reconnecting, error, clearError: () => setError(''),
    changeConversation, send, stop };
}
