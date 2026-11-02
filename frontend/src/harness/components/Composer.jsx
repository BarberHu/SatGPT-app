import React, { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Loader2, MapPin } from 'lucide-react';
import { Button } from '../ui/button';
import AttachmentList from './AttachmentList';

export default function Composer({ value, onChange, onSend, busy, pending, disabled, mapReady }) {
  const input = useRef(null);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [value]);
  return <div className="agent-composer-wrap">
    <form className="agent-composer harness-compose" onSubmit={event => { event.preventDefault(); if (value.trim() && !disabled) onSend(); }}>
      <AttachmentList items={[]} />
      <textarea ref={input} aria-label="Message" value={value} rows={2}
        onChange={event => onChange(event.target.value)}
        placeholder="Ask about the map, explore data, or start an analysis…"
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (!disabled && value.trim()) onSend();
          }
        }} />
      <div className="agent-composer-bottom"><span><MapPin size={13} />{mapReady ? 'Using current map extent' : 'Waiting for map'}</span>
        <Button type="submit" size="icon" className="agent-send" disabled={disabled || !value.trim()} aria-label={busy ? 'Running' : pending ? 'Sending' : 'Send'}>
          {busy || pending ? <Loader2 className="agent-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </form>
    <p className="agent-composer-note">SatGPT can make mistakes. Check observation dates and data sources.</p>
  </div>;
}
