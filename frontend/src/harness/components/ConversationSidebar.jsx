import React from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { Button } from '../ui/button';

export default function ConversationSidebar({ conversations, currentId, disabled, onNew, onSelect, onCollapse }) {
  return <aside className={`agent-history${onCollapse ? ' has-close' : ''}`} aria-label="Conversation history">
    {onCollapse ? <Button type="button" variant="ghost" size="icon" className="agent-history-close" aria-label="Collapse conversation history" onClick={onCollapse}><X /></Button> : null}
    <Button type="button" variant="outline" className="agent-new" onClick={onNew} disabled={disabled}><Plus />New chat</Button>
    <p className="agent-history-label">Your conversations</p>
    <nav className="agent-conversations" aria-label="Conversations">
      {conversations.length === 0 ? <p className="agent-history-empty">Your conversations will appear here</p> : null}
      {conversations.map(item => {
        const running = item.task_status === 'running';
        const queued = item.task_status === 'queued';
        return <button type="button" key={item.id} disabled={disabled && item.id !== currentId}
        className={`agent-conversation ${item.id === currentId ? 'is-current' : ''}`}
        aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
        <span className="agent-conversation-title">{item.title}</span>
        {running || queued ? <span className="agent-conversation-status" role="status" aria-label={running ? 'Running' : 'Queued'} title={running ? 'Running' : 'Queued'}>
          <Loader2 size={14} className="agent-spin" aria-hidden="true" />
        </span> : item.unread && item.id !== currentId ? <span className="agent-conversation-unread" role="status" aria-label="Unread response" title="New response" /> : null}
      </button>;
      })}
    </nav>
  </aside>;
}
