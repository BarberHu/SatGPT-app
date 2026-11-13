import React, { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';

export default function ConversationActions({ title, disabled, onDelete }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const area = useRef(null), trigger = useRef(null), item = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    item.current?.focus();
    const outside = event => { if (!area.current?.contains(event.target)) setOpen(false); };
    // Handle the inner menu before the mobile Dialog's document-level Escape listener.
    const escape = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const show = () => {
    const bounds = trigger.current.getBoundingClientRect();
    const container = trigger.current.closest('nav')?.getBoundingClientRect();
    setAbove(Boolean(container && bounds.bottom + 52 > container.bottom));
    setOpen(true);
  };
  return <div ref={area} className="agent-conversation-actions" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false); trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); item.current?.focus();
    }
  }}>
    <Button ref={trigger} type="button" variant="ghost" size="icon" className="agent-conversation-more"
      aria-label={`Conversation options: ${title}`} title="Conversation options" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => { if (open) setOpen(false); else show(); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}><MoreHorizontal size={17} /></Button>
    {open ? <div id={id} role="menu" aria-label={`Actions for ${title}`} className="agent-conversation-menu" data-above={above}>
      <button ref={item} type="button" role="menuitem" onClick={() => {
        setOpen(false); onDelete(trigger.current);
      }}><Trash2 size={15} />Delete</button>
    </div> : null}
  </div>;
}
