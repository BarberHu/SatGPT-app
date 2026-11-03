export const emptyStream = (taskId) => ({ taskId, task: null, answer: null, cursor: -1 });

/** SSE IDs order the task feed; attempt IDs order provisional answer lifetimes. */
export function receiveStream(state, event) {
  if (event.task_id !== state.taskId || !Number.isInteger(event.id) || event.id <= state.cursor) return state;
  if (event.type !== 'snapshot' && event.id !== state.cursor + 1) return state;
  const next = { ...state, cursor: event.id };
  if (event.type === 'snapshot') return { ...next, task: event.task, answer: event.answer };
  if (event.type === 'task') {
    next.task = { ...state.task, ...event.patch };
    if (['completed', 'failed', 'cancelled'].includes(next.task.status)) next.answer = null;
  } else if (event.type === 'answer.start') next.answer = event.answer;
  else if (event.type === 'answer.delta' && state.answer?.attempt_id === event.attempt_id) {
    next.answer = { ...state.answer, text: state.answer.text + event.text };
  } else if (event.type === 'reasoning.delta' && state.answer?.attempt_id === event.attempt_id) {
    next.answer = { ...state.answer, reasoning: (state.answer.reasoning || '') + event.text };
  } else if (event.type === 'answer.settle' && state.answer?.attempt_id === event.answer.attempt_id) {
    next.answer = event.answer;
  } else if (event.type === 'answer.reset' && (!event.attempt_id || state.answer?.attempt_id === event.attempt_id)) next.answer = null;
  if (event.timeline_ops?.length && next.task) {
    let rows = [...(next.task.timeline || [])];
    for (const operation of event.timeline_ops) {
      if (operation.op === 'remove') rows = rows.filter(row => !operation.ids.includes(row.id));
      else if (operation.op === 'append') rows = rows.map(row => row.id === operation.id
        ? { ...row, text: row.text + operation.text } : row);
      else if (operation.op === 'put') {
        const index = rows.findIndex(row => row.id === operation.row.id);
        if (index < 0) rows.push(operation.row);
        else rows[index] = operation.row;
      }
    }
    next.task = { ...next.task, timeline: rows };
  }
  return next;
}
