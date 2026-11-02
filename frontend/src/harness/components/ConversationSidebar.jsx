import React from 'react';
import { MessageSquare, Plus, X } from 'lucide-react';
import { Button } from '../ui/button';

export default function ConversationSidebar({ conversations, currentId, disabled, onNew, onSelect, onCollapse }) {
  return <aside className={`agent-history${onCollapse ? ' has-close' : ''}`} aria-label="Conversation history">
    {onCollapse ? <Button type="button" variant="ghost" size="icon" className="agent-history-close" aria-label="Collapse conversation history" onClick={onCollapse}><X /></Button> : null}
    <Button type="button" variant="outline" className="agent-new" onClick={onNew} disabled={disabled}><Plus />New chat</Button>
    <p className="agent-history-label">Your conversations</p>
    <nav className="agent-conversations" aria-label="Conversations">
      {conversations.length === 0 ? <p className="agent-history-empty">Your conversations will appear here</p> : null}
      {conversations.map(item => <button type="button" key={item.id} disabled={disabled && item.id !== currentId}
        className={`agent-conversation ${item.id === currentId ? 'is-current' : ''}`}
        aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
        <MessageSquare size={14} /><span>{item.title}</span>{item.id === currentId ? <i aria-label="Current conversation" /> : null}
      </button>)}
    </nav>
  </aside>;
}
