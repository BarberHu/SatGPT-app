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
  const [error, setError] = useState('');
  const source = useRef(null);
  const generation = useRef(0);
  const request = useRef(null);
  const watch = useRef(null);
  const conversationId = useRef(null);
  const alive = useRef(false);

  const refreshList = useCallback(async (signal) => {
    const data = await chatApi.list(signal);
    if (alive.current && !signal?.aborted) setConversations(data.conversations || []);
  }, []);

  const load = useCallback(async (epoch, signal) => {
    const data = await chatApi.current(signal);
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
        if (['completed', 'failed'].includes(state.task.status)) {
          stream.close();
          source.current = null;
          setReconnecting(false);
          await load(epoch, request.current?.signal);
          await refreshList(request.current?.signal);
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
    if (pending || ['queued', 'running'].includes(task?.status)) return false;
    setPending(true);
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
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message);
      return false;
    } finally {
      if (alive.current && epoch === generation.current) setPending(false);
    }
  }, [pending, task?.status, refreshList]);

  const send = useCallback(async (prompt, bounds) => {
    if (pending || loading || ['queued', 'running'].includes(task?.status)) return false;
    setPending(true);
    setError('');
    const epoch = generation.current;
    try {
      const next = await chatApi.send({ prompt, bounds, conversation_id: conversationId.current }, request.current?.signal);
      if (!alive.current || epoch !== generation.current) return false;
      setTask(next);
      await load(epoch, request.current?.signal);
      if (alive.current && epoch === generation.current) watch.current(next.id);
      return true;
    } catch (cause) {
      if (alive.current && epoch === generation.current && cause.name !== 'AbortError') setError(cause.message);
      return false;
    } finally {
      if (alive.current && epoch === generation.current) setPending(false);
    }
  }, [pending, loading, task?.status, load]);

  const view = useMemo(() => chatViewModel(conversation.messages, task, answer), [conversation.messages, task, answer]);
  return { ...view, conversationId: conversation.conversation_id, messages: conversation.messages,
    conversations, loading, pending, reconnecting, error, clearError: () => setError(''),
    changeConversation, send };
}
