import React from 'react';
import { Camera, Settings2, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';

const modes = [{ id: 'basic', label: 'Static layers' }, { id: 'agent', label: 'Intelligent analysis' }];
export default function WorkspaceHeader({ mode, onModeChange, canCapture, capturing, onCapture, captureHint,
  basemaps, basemapId, canChangeBasemap, basemapSwitching, onBasemapChange }) {
  const navigate = event => {
    const index = modes.findIndex(item => item.id === mode);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % modes.length
        : event.key === 'ArrowLeft' ? (index - 1 + modes.length) % modes.length : null;
    if (next === null) return;
    event.preventDefault();
    onModeChange(modes[next].id);
    event.currentTarget.querySelector(`[data-mode="${modes[next].id}"]`)?.focus();
  };
  return <header className="satgpt-topbar" aria-label="SatGPT workspace">
    <div className="satgpt-topbar-brand">
      <img className="satgpt-topbar-mark" src="/assets/images/satgpt-avatar.png" width="30" height="30" alt="" aria-hidden="true" />
      <img className="satgpt-topbar-wordmark" src="/assets/images/satgpt-wordmark.png" width="2954" height="369" alt="SatGPT Logo" />
    </div>
    <div className="satgpt-mode-tabs" role="tablist" aria-label="Workspace mode" onKeyDown={navigate}>
      {modes.map(item => <button key={item.id} type="button" role="tab" id={`satgpt-tab-${item.id}`}
        data-mode={item.id} aria-selected={mode === item.id} aria-controls={`satgpt-panel-${item.id}`}
        tabIndex={mode === item.id ? 0 : -1} onClick={() => onModeChange(item.id)}>{item.label}</button>)}
    </div>
    <div className="satgpt-topbar-actions">
      {basemaps?.length > 1 ? <label className="satgpt-basemap">
        <span>Basemap</span>
        <select aria-label="Basemap" aria-busy={basemapSwitching} value={basemapId} disabled={!canChangeBasemap}
          onChange={event => onBasemapChange(event.target.value)}>
          {basemaps.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label> : null}
      <button type="button" className="satgpt-toolbar-button" aria-label="Save map image" title={canCapture ? 'Save current map image' : captureHint || 'Map capture will be available when the map is ready'}
        disabled={!canCapture || capturing} onClick={onCapture}><Camera size={20} strokeWidth={1.7} /></button>
      <Dialog.Root><Dialog.Trigger asChild>
        <button type="button" className="satgpt-toolbar-button" aria-label="Settings" title="Settings (coming soon)"><Settings2 size={20} strokeWidth={1.7} /></button>
      </Dialog.Trigger><Dialog.Portal>
        <Dialog.Overlay className="satgpt-settings-overlay" />
        <Dialog.Content className="satgpt-settings-dialog">
          <Dialog.Title>Settings<span className="satgpt-settings-badge">Coming soon</span></Dialog.Title>
          <Dialog.Description>Personal Harness API keys will be supported in a future release. Server configuration is currently used; no keys are collected or stored here.</Dialog.Description>
          <label htmlFor="satgpt-harness-key">Harness API Key</label>
          <input id="satgpt-harness-key" type="password" disabled placeholder="Available in a future release" autoComplete="off" />
          <Dialog.Close className="satgpt-settings-close" aria-label="Close settings"><X size={18} /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal></Dialog.Root>
    </div>
  </header>;
}
