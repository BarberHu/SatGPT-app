import React, { useId, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import './layers.css';

/** Presentation only. Layer ownership, requests and visibility stay with each mode. */
export default function LayerPanel({ count, children, className = '', scrollClassName = '', editing = false,
  open, onOpenChange }) {
  const [localOpen, setLocalOpen] = useState(true);
  const contentId = useId();
  const preferredOpen = open ?? localOpen;
  const expanded = preferredOpen && !editing;
  return <section className={`workspace-layer-panel ${className}${expanded ? '' : ' is-collapsed'}${editing ? ' is-editing' : ''}`} aria-label="Current layers">
    <button type="button" className="workspace-layer-heading" aria-expanded={expanded} aria-controls={contentId}
      disabled={editing} title={editing ? 'Finish or cancel area editing to reopen layers' : undefined}
      onClick={() => onOpenChange ? onOpenChange(!preferredOpen) : setLocalOpen(!preferredOpen)}>
      <Layers size={16} aria-hidden="true" /><strong>Current layers</strong><span className="workspace-layer-count">{count}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    <div id={contentId} className={`workspace-layer-scroll ${scrollClassName}`} hidden={!expanded}>{children}</div>
  </section>;
}
