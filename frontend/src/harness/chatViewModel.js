import { isActiveTask, isTerminalTask } from './taskStatus.js';
/** UI domain objects. The array order is the event order, never a type/time sort. */
import { messageLayerBounds } from './map/viewState';

function presentRun(source, busy, finalText) {
  const ordered = source.timeline || [];
  let timeline = ordered.map(row => ({ ...row,
    status: row.status === 'running' && !busy ? 'unknown' : row.status,
    streaming: !row.committed && busy,
  }));
  let text = finalText || '';
  const tail = timeline.at(-1);
  if (tail?.kind === 'text') {
    if (!text) { text = tail.text; timeline = timeline.slice(0, -1); }
    else if (tail.text.trim() === text.trim()) timeline = timeline.slice(0, -1);
  }
  return { text, timeline, run: { status: busy ? (source.status || 'running') : source.status || 'completed',
    startedAt: source.started_at, finishedAt: source.finished_at } };
}

export function chatViewModel(messages, task, answer) {
  const items = messages.map(message => ({
    id: message.id, role: message.role,
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
  if (task && !settled && (busy || isTerminalTask(task.status))) {
    items.push({ id: `task-${task.id}`, role: 'assistant',
      ...presentRun(task, busy, task.status === 'failed' ? task.error : task.output?.message || ''),
      streaming: busy && answer?.status === 'streaming', pending: busy,
      failed: task.status === 'failed', attachments: [], layers: [], code: '' });
  }
  return { items, busy };
}
