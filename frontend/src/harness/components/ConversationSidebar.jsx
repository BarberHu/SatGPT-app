import React, { useRef, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';

export default function ConversationSidebar({ conversations, currentId, disabled, onNew, onSelect, onCollapse, onDelete, deleteError }) {
  const [selected, setSelected] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const cancelButton = useRef(null);
  const confirmDelete = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setDeleting(true);
    setFailed(false);
    try {
      if (await onDelete(selected.id)) setSelected(null);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setDeleting(false);
    }
  };
  return <aside className={`agent-history${onCollapse ? ' has-close' : ''}`} aria-label="Conversation history">
    {onCollapse ? <Button type="button" variant="ghost" size="icon" className="agent-history-close" aria-label="Collapse conversation history" onClick={onCollapse}><X /></Button> : null}
    <Button type="button" variant="outline" className="agent-new" onClick={onNew} disabled={disabled}><Plus />New chat</Button>
    <p className="agent-history-label">Your conversations</p>
    <nav className="agent-conversations" aria-label="Conversations">
      {conversations.length === 0 ? <p className="agent-history-empty">Your conversations will appear here</p> : null}
      {conversations.map(item => {
        const running = item.task_status === 'running';
        const queued = item.task_status === 'queued';
        return <div key={item.id} className="agent-conversation-row">
        <button type="button" disabled={disabled && item.id !== currentId}
        className={`agent-conversation ${item.id === currentId ? 'is-current' : ''}`}
        aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
        <span className="agent-conversation-title">{item.title}</span>
        {running || queued ? <span className="agent-conversation-status" role="status" aria-label={running ? 'Running' : 'Queued'} title={running ? 'Running' : 'Queued'}>
          <Loader2 size={14} className="agent-spin" aria-hidden="true" />
        </span> : item.unread && item.id !== currentId ? <span className="agent-conversation-unread" role="status" aria-label="Unread response" title="New response" /> : null}
        </button>
        {onDelete ? <Button type="button" variant="ghost" size="icon" className="agent-conversation-delete"
          aria-label={`Delete conversation: ${item.title}`} title={running || queued ? 'Wait for this task to finish before deleting' : 'Delete conversation'}
          disabled={disabled || running || queued} onClick={() => { setFailed(false); setSelected(item); }}><Trash2 size={14} /></Button> : null}
        </div>;
      })}
    </nav>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !submitting.current) setSelected(null); }}>
      <DialogContent className="agent-delete-dialog" onOpenAutoFocus={event => {
        event.preventDefault();
        cancelButton.current?.focus();
      }}>
        <DialogTitle>Delete conversation?</DialogTitle>
        <DialogDescription>This will delete “{selected?.title}” from your conversation history. This cannot be undone.</DialogDescription>
        {failed ? <p role="alert" className="agent-delete-error">{deleteError || 'Unable to delete the conversation. Please try again.'}</p> : null}
        <div className="agent-delete-actions">
          <Button ref={cancelButton} type="button" variant="outline" disabled={deleting} onClick={() => setSelected(null)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </aside>;
}
