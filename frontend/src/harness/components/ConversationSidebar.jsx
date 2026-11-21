import { isActiveTask } from '../taskStatus';
import React, { useRef, useState } from 'react';
import { ChevronsLeft, Loader2, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import ConversationActions from './ConversationActions';
import ConversationRecovery from './ConversationRecovery';

function groupedConversations(conversations) {
  const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = [{ label: null, rows: [] }, { label: 'Today', rows: [] }, { label: 'Earlier', rows: [] }];
  for (const item of conversations) {
    const date = typeof item.updated_at === 'string' && item.updated_at ? new Date(item.updated_at) : null;
    const group = !date || !Number.isFinite(date.getTime()) ? 0 : date.toDateString() === now.toDateString() ? 1 : date < start ? 2 : 0;
    groups[group].rows.push(item);
  }
  return groups.filter(group => group.rows.length);
}

export default function ConversationSidebar({ conversations, currentId, disabled, onNew, onSelect, onCollapse, onDelete, deleteError, collapseButtonRef, onRecovered }) {
  const [selected, setSelected] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const cancelButton = useRef(null);
  const deleteButton = useRef(null);
  const newChatButton = useRef(null);
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
  return <aside className="agent-history" aria-label="Conversation history">
    <div className="agent-history-header">
      <h2>Conversations</h2>
      <Button ref={newChatButton} type="button" variant="ghost" size="icon" className="agent-new" onClick={onNew}
        disabled={disabled} aria-label="New chat" title="New chat"><Plus size={18} /></Button>
      {onCollapse ? <Button ref={collapseButtonRef} type="button" variant="ghost" size="icon" className="agent-history-close"
        aria-label="Collapse conversation history" aria-expanded={true} title="Collapse conversation history" onClick={onCollapse}><ChevronsLeft size={18} /></Button> : null}
    </div>
    <nav className="agent-conversations" aria-label="Conversations">
      {conversations.length === 0 ? <p className="agent-history-empty">Your conversations will appear here</p> : null}
      {groupedConversations(conversations).map(group => <section key={group.label || 'undated'}>
      {group.label ? <h3 className="agent-history-label">{group.label}</h3> : null}
      {group.rows.map(item => {
        const active = isActiveTask(item.task_status);
        const statusLabel = { queued: 'Queued', starting: 'Starting', running: 'Running',
          cancelling: 'Stopping', cleaning: 'Finishing' }[item.task_status];
        return <div key={item.id} className="agent-conversation-row">
        <button type="button" disabled={disabled && item.id !== currentId}
        className={`agent-conversation ${item.id === currentId ? 'is-current' : ''}`}
        aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
        <span className="agent-conversation-title">{item.title}</span>
        {active ? <span className="agent-conversation-status" role="status" aria-label={statusLabel} title={statusLabel}>
          <Loader2 size={14} className="agent-spin" aria-hidden="true" />
        </span> : item.unread && item.id !== currentId ? <span className="agent-conversation-unread" role="status" aria-label="Unread response" title="New response" /> : null}
        </button>
        {onDelete ? <ConversationActions title={item.title} disabled={disabled || active}
          onDelete={trigger => { deleteButton.current = trigger; setFailed(false); setSelected(item); }} /> : null}
        </div>;
      })}</section>)}
    </nav>
    {onRecovered ? <ConversationRecovery key={currentId} currentId={currentId} onRecovered={onRecovered} /> : null}
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !submitting.current) setSelected(null); }}>
      <DialogContent className="agent-delete-dialog" onOpenAutoFocus={event => {
        event.preventDefault();
        cancelButton.current?.focus();
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        (deleteButton.current?.isConnected ? deleteButton.current : newChatButton.current)?.focus();
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
