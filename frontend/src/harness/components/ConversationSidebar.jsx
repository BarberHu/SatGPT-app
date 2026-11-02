import React from 'react';
import { ArrowLeft, Globe2, MessageSquare, PanelLeftClose, Plus } from 'lucide-react';
import { Button } from '../ui/button';

export default function ConversationSidebar({ conversations, currentId, disabled, onNew, onSelect, onCollapse, onSwitchBasic }) {
  return <aside className="agent-history" aria-label="历史会话">
    <div className="agent-brand"><span><Globe2 size={21} strokeWidth={1.5} /><strong>SatGPT</strong></span>
      <Button type="button" variant="ghost" size="icon" aria-label="收起历史会话" onClick={onCollapse}><PanelLeftClose /></Button>
    </div>
    <Button type="button" variant="outline" className="agent-new" onClick={onNew} disabled={disabled}><Plus />新对话</Button>
    <p className="agent-history-label">你的对话</p>
    <nav className="agent-conversations" aria-label="会话列表">
      {conversations.length === 0 ? <p className="agent-history-empty">对话会保存在这里</p> : null}
      {conversations.map(item => <button type="button" key={item.id} disabled={disabled && item.id !== currentId}
        className={`agent-conversation ${item.id === currentId ? 'is-current' : ''}`}
        aria-current={item.id === currentId ? 'page' : undefined} onClick={() => onSelect(item.id)} title={item.title}>
        <MessageSquare size={14} /><span>{item.title}</span>{item.id === currentId ? <i aria-label="当前会话" /> : null}
      </button>)}
    </nav>
    <div className="agent-history-footer"><span className="agent-engine-label"><i />地理空间助手</span>
      <Button type="button" variant="ghost" className="agent-basic-switch" onClick={onSwitchBasic}><ArrowLeft />返回 Basic</Button>
    </div>
  </aside>;
}
