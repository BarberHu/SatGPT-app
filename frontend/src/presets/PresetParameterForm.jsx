import React, { useState } from 'react';
import { defaultPresetParams, localDate } from '../config/presetLayerCatalog';

export default function PresetParameterForm({ preset, onApply, disabled, initialParams, editing, onCancel }) {
  const [params, setParams] = useState(() => initialParams || defaultPresetParams(preset));
  const [error, setError] = useState('');
  const input = (key, title, type, attributes = {}) => <label key={key}>{title}<input name={key} aria-label={title} type={type}
    value={params[key] ?? ''} {...attributes} onChange={event => { const value = event.target.value; setParams(current => ({ ...current, [key]: value })); }} required /></label>;
  return <form className="preset-parameters" onSubmit={event => {
    event.preventDefault(); setError('');
    try { onApply(Object.fromEntries(new FormData(event.currentTarget))); } catch (error) { setError(error.message); }
  }}>
    <p>{preset.infoText}</p>
    {preset.model ? <span className="preset-badge">Model-based index</span> : null}
    {preset.form === 'years' ? <div className="preset-inputs">{input('year_start', 'Start year', 'number', { min: 1984, max: 2021 })}{input('year_end', 'End year', 'number', { min: 1984, max: 2021 })}</div> : null}
    {preset.form === 'dates' ? <><div className="preset-inputs">{input('time_start', 'Start date', 'date', { min: preset.model ? '2020-03-28' : '2000-11-01', max: localDate(new Date()) })}
      {input('time_end', 'End date (exclusive)', 'date', { max: localDate(new Date()) })}</div>
      <small>{preset.minRecentWindow}–{preset.maxRecentWindow} days. Source observations may lag. {preset.model ? 'Uses a preceding 3-year baseline.' : 'Selects monthly MODIS products by timestamp.'}</small>
      {preset.model ? input('cloud_threshold', 'Maximum scene cloud cover (%)', 'number', { min: 0, max: 100 }) : null}</> : null}
    {preset.form === 'fixed' ? <small>Fixed dataset; no date adjustment. {preset.detailText}</small> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="preset-actions"><button className="preset-primary" type="submit" disabled={disabled}>{editing ? 'Apply to this layer' : 'Load layer'}</button>
      {onCancel ? <button type="button" onClick={onCancel}>Cancel</button> : null}</div>
  </form>;
}
