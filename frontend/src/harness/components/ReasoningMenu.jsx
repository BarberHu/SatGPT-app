import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '../ui/button';

const LABELS = new Map([['off', 'Off'], ['low', 'Low'], ['high', 'High'], ['max', 'Max']]);
const DEFAULT = 'Server default';
const TITLE = 'Reasoning effort';
const STATUS = {
  loading: 'Loading reasoning levels…',
  ready: 'This model uses the server default.',
  missing: 'The connected server does not provide reasoning levels.',
  failed: 'Unable to load reasoning levels. Try again.',
};
const label = level => level ? LABELS.get(level.id) ?? level.name : DEFAULT;

export default function ReasoningMenu({ options, value, onChange, onRetry }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const { model, levels = [], status } = options;
  const selected = label(levels.find(level => level.id === value));
  const deploymentDefault = levels.find(level => level.id === options.default_effort);
  const canChoose = levels.length > 0;

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = panel.current;
    (target.querySelector('[aria-checked="true"]') || target.querySelector('button') || target).focus();
  }, [open, status, value]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = effort => { onChange(effort); close(); };
  const navigate = event => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    const buttons = [...panel.current.querySelectorAll('button')];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    if (index !== -1 && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      buttons[index].click();
      return;
    }
    const next = {
      Home: 0, End: buttons.length - 1,
      ArrowDown: (index + 1) % buttons.length,
      ArrowUp: index > 0 ? index - 1 : buttons.length - 1,
    }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    buttons[next].focus();
  };

  return <div className="agent-reasoning" ref={root} onKeyDown={navigate}
    onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
    <Button type="button" ref={trigger} variant="ghost" className="agent-reasoning-trigger"
      aria-label={[TITLE, model, selected].filter(Boolean).join(' · ')}
      title={model || TITLE} aria-haspopup={canChoose ? 'menu' : undefined}
      aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) close(); else setOpen(true); }}
      onKeyDown={event => {
        if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          setOpen(true);
        }
      }}>
      <span className="agent-reasoning-model">{model || TITLE}</span>
      <span className="agent-reasoning-current">{selected}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </Button>
    {open ? <div id={id} ref={panel} className="agent-reasoning-panel" tabIndex={-1}
      role={canChoose ? 'menu' : undefined} aria-label={TITLE}>
      {canChoose ? [{ id: '', name: DEFAULT }, ...levels].map(level =>
        <button key={level.id} type="button" role="menuitemradio" tabIndex={-1} aria-checked={value === level.id}
          onClick={() => choose(level.id)}>
          <span>{label(level)}</span>
          {!level.id && deploymentDefault ? <span className="agent-reasoning-current" aria-hidden="true">{label(deploymentDefault)}</span> : null}
          {value === level.id ? <Check size={15} aria-hidden="true" /> : null}
        </button>
      ) : <>
        <p role="status">{STATUS[status]}</p>
        {status === 'missing' || status === 'failed' ? <button type="button" onClick={onRetry}>Retry</button> : null}
      </>}
    </div> : null}
  </div>;
}
