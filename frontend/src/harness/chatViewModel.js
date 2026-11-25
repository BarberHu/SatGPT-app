import { isActiveTask, isTerminalTask } from './taskStatus.js';
/** UI domain objects. The array order is the event order, never a type/time sort. */
import { messageLayerBounds } from './map/viewState';

function presentRun(source, busy, finalText, answer) {
  const timeline = [];
  const replyParts = [];
  for (const row of source.timeline || []) {
    if (row.kind === 'text') {
      if (row.text?.trim() && (busy || row.committed !== false)) {
        replyParts.push({ id: row.id, attemptId: row.attempt_id, text: row.text, streaming: !row.committed && busy });
      }
    } else {
      timeline.push({ ...row, status: row.status === 'running' && !busy ? 'unknown' : row.status,
        streaming: !row.committed && busy });
    }
  }
  // The server can remove the final attempt's duplicate rows just before sending the terminal snapshot.
  if (busy && answer?.status === 'committed' && answer.text?.trim()
    && !replyParts.some(part => part.attemptId === answer.attempt_id)) {
    replyParts.push({ id: `settled-${answer.attempt_id}`, text: answer.text, streaming: false });
  }
  return { text: finalText || '', timeline, replyParts, usage: busy ? undefined : source.dev_turn_usage,
    run: { status: busy ? (source.status || 'running') : source.status || 'completed',
    startedAt: source.started_at, finishedAt: source.finished_at } };
}

export function chatViewModel(messages, task, answer) {
  const items = messages.map(message => ({
    id: message.id, role: message.role, jobId: message.job_id,
    analysisRegion: message.analysis_region, analysisAoi: message.analysis_aoi,
    hasScope: Object.hasOwn(message, 'analysis_region'),
    ...presentRun(message, false, message.content || ''),
    failed: message.status === 'failed', streaming: false,
    code: message.code || '',
    attachments: (message.previews || []).map((preview, index) => ({
      id: `${message.id}-preview-${index}`, type: 'image', url: preview.url,
      name: preview.name || 'GEE image preview',
    })),
    layers: (message.layers || []).map((layer, index) => ({ ...layer, id: `${message.job_id}-${index}`,
      bounds: messageLayerBounds(message, layer) })),
  }));
  const busy = Boolean(task && isActiveTask(task.status));
  const settled = messages.some(item => item.role === 'assistant' && item.job_id === task?.id);
  let activity = null;
  if (task && !settled && (busy || isTerminalTask(task.status))) {
    const finalText = task.status === 'failed' ? task.error : task.output?.message;
    const reply = presentRun(task, busy, finalText, answer);
    items.push({ id: `task-${task.id}`, role: 'assistant', jobId: task.id,
      ...reply, pending: busy,
      failed: task.status === 'failed', attachments: [], layers: [], code: '' });
    if (busy) {
      const tool = reply.timeline.findLast(row => row.kind === 'tool' && row.status === 'running');
      const notice = reply.replyParts.at(-1);
      activity = { id: task.id, status: task.status, createdAt: task.created_at ?? task.started_at,
        tool: tool?.name, noticeId: notice?.attemptId ?? notice?.id };
    }
  }
  return { items, busy, activity };
}
