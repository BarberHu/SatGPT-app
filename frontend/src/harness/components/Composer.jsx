import React, { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Loader2, MapPin, Pencil, Pentagon, Square, X } from 'lucide-react';
import { Button } from '../ui/button';
import ReasoningMenu from './ReasoningMenu';
import { regionPresentation } from '../map/regionPresentation';

export default function Composer({ value, onChange, onSend, onStop, busy, pending, stopping, stopDisabled, disabled,
  mapReady, region, onEditRegion, areaControls, reasoning, reasoningEffort, onReasoningChange, onReasoningRetry }) {
  const input = useRef(null);
  const area = regionPresentation(region, mapReady);
  const sendingDisabled = disabled || region?.editing;
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 160)}px`;
  }, [value]);
  return <div className="agent-composer-wrap">
    <form className="agent-composer" onSubmit={event => { event.preventDefault(); if (value.trim() && !sendingDisabled) onSend(); }}>
      <textarea ref={input} aria-label="Message" value={value} rows={1}
        onChange={event => onChange(event.target.value)}
        placeholder="Ask about the map, explore data, or start an analysis…"
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (!sendingDisabled && value.trim()) onSend();
          }
        }} />
      <div className="agent-composer-bottom">
        <div className="agent-composer-area">
          <div className={`agent-region-entry agent-region-entry--${area.state}`} role="group" aria-label="Analysis area">
            {area.state === 'viewport' ? <>
              <span className="agent-region-viewport"><MapPin size={13} aria-hidden="true" /><span>{area.label}</span></span>
              <button type="button" className="agent-region-draw" onClick={onEditRegion}
                disabled={!region?.ready || pending} aria-label="Draw analysis area"><Pentagon size={14} aria-hidden="true" />Draw area</button>
            </> : <div className="agent-region-chip">
              <Pentagon className="agent-region-icon" size={15} aria-hidden="true" />
              <span className="agent-region-label" role="status" title={area.label}>{area.label}</span>
              {area.state === 'confirmed' ? <button type="button" className="agent-region-action agent-region-edit" onClick={onEditRegion}
                disabled={!region?.ready || pending} aria-label="Edit analysis area" title="Edit analysis area"><Pencil size={13} aria-hidden="true" /></button> : null}
              <button type="button" className="agent-region-action" onClick={region?.editing ? region.cancel : region?.clear}
                disabled={pending} aria-label={region?.editing ? 'Cancel area editing' : 'Clear analysis area'}
                title={region?.editing ? 'Cancel area editing' : 'Remove from this analysis; saved areas are kept'}><X size={14} aria-hidden="true" /></button>
            </div>}
          </div>
          {areaControls}
          {area.hint ? <p className="agent-region-hint" role={region?.error ? 'alert' : undefined}>{area.hint}</p> : null}
        </div>
        <div className="agent-composer-actions">
          {reasoning ? <ReasoningMenu options={reasoning} value={reasoningEffort}
            onChange={onReasoningChange} onRetry={onReasoningRetry} /> : null}
          {busy ? <Button type="button" size="icon" className="agent-send" onClick={onStop}
            disabled={stopping || stopDisabled} aria-label={stopping ? 'Stopping' : 'Stop response'} title="Stop response">
            {stopping ? <Loader2 className="agent-spin" /> : <Square size={16} fill="currentColor" />}
          </Button> : <Button type="submit" size="icon" className="agent-send" disabled={sendingDisabled || !value.trim()} aria-label={pending ? 'Sending' : 'Send'}>
            {pending ? <Loader2 className="agent-spin" /> : <ArrowUp />}
          </Button>}
        </div>
      </div>
    </form>
    <p className="agent-composer-note">SatGPT can make mistakes. Check observation dates and data sources.</p>
  </div>;
}
