import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'satgpt:harness:conversation-activity';
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const active = status => ['queued', 'running'].includes(status);

function readActivity() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Object.fromEntries(Object.entries(data || {}).filter(([, item]) =>
      item && typeof item.taskId === 'string' && (active(item.status) || terminal(item.status)) && typeof item.seen === 'boolean'));
  } catch { return {}; }
}

/** Only task IDs and read markers are stored; conversation content stays on the server. */
export function useConversationActivity(rows, conversation, visible, deletedId = null) {
  const [activity, setActivity] = useState(readActivity);
  useEffect(() => {
    setActivity(previous => {
      const next = { ...previous };
      let changed = false;
      if (deletedId && Object.hasOwn(next, deletedId)) {
        delete next[deletedId];
        changed = true;
      }
      for (const row of rows) {
        if (row.id === deletedId) continue;
        const latest = row.latest_task || (row.active_task ? { id: row.active_task, status: row.task_status } : null);
        const old = previous[row.id];
        let item = old;
        if (latest && (active(latest.status) || terminal(latest.status))) {
          item = { taskId: latest.id, status: latest.status,
            seen: active(latest.status) ? false : old?.taskId === latest.id ? old.seen : !old };
        }
        // Viewing a running chat does not pre-mark its future response as read.
        if (item && terminal(item.status) && visible && row.id === conversation.conversation_id
            && conversation.messages.some(message => message.role === 'assistant' && message.job_id === item.taskId)) {
          item = { ...item, seen: true };
        }
        if (item && (item.taskId !== old?.taskId || item.status !== old?.status || item.seen !== old?.seen)) {
          next[row.id] = item;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [rows, conversation, visible, deletedId]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(activity)); }
    catch { /* Read indicators still work when browser storage is unavailable. */ }
  }, [activity]);
  return useMemo(() => rows.map(row => ({ ...row,
    unread: Boolean(activity[row.id] && terminal(activity[row.id].status) && !activity[row.id].seen),
  })), [rows, activity]);
}
