import React, { useRef, useState } from 'react';
import shp from 'shpjs';
import { useAppContext } from '../context/AppContext';
import { buildAoiFromAgentState, buildAoiFromGeoJSON } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';

function AoiUploadPanel({ variant = 'ask' }) {
  const fileInputRef = useRef(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const {
    selectedAOI,
    draftAOI,
    setSelectedAOI,
    setSelectedGridCords,
    setWarning,
    floodAgentState,
    isAoiEditing,
    startAoiDraw,
    startAoiEdit,
    applyDraftAoi,
    cancelDraftAoi,
    resetAgentSession,
    resetAskSession,
  } = useAppContext();

  const effectiveAoi = selectedAOI || buildAoiFromAgentState(floodAgentState, {
    source: 'agent_geocode',
    label: floodAgentState?.location || 'Agent-derived boundary',
  });
  const hasEditableAoi = Boolean(effectiveAoi);

  const openFilePicker = () => {
    if (isAoiEditing) return;
    fileInputRef.current?.click();
  };

  const clearAoi = () => {
    resetAskSession();
    setSelectedAOI(null);
    setSelectedGridCords(null);
    setWarning('');
    resetAgentSession({ preserveSelectedAoi: false });
    trackUxEvent('aoi_clear', { mode: variant });
  };

  const readFileAsText = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsText(file);
    });

  const readFileAsArrayBuffer = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });

  const parseBoundaryFile = async (file) => {
    const lowerName = file.name.toLowerCase();

    if (lowerName.endsWith('.geojson') || lowerName.endsWith('.json')) {
      const text = await readFileAsText(file);
      return JSON.parse(text);
    }

    if (lowerName.endsWith('.zip')) {
      const buffer = await readFileAsArrayBuffer(file);
      return shp(buffer);
    }

    throw new Error('Only GeoJSON (.geojson/.json) and zipped Shapefile (.zip) are supported.');
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsParsing(true);
    setWarning('');

    try {
      const parsed = await parseBoundaryFile(file);
      const aoi = buildAoiFromGeoJSON(parsed, {
        source: 'upload',
        label: file.name.replace(/\.(geojson|json|zip)$/i, ''),
      });

      if (!aoi) {
        throw new Error('The file does not contain a valid Polygon or MultiPolygon boundary.');
      }

      resetAskSession();
      setSelectedGridCords(null);
      setSelectedAOI(aoi);
      cancelDraftAoi();
      resetAgentSession({ preserveSelectedAoi: true });
      trackUxEvent('aoi_upload_success', {
        mode: variant,
        fileName: file.name,
        source: aoi.source,
        kind: aoi.kind,
      });
    } catch (error) {
      const message = error?.message || 'Boundary parsing failed.';
      setWarning(message);
      trackUxEvent('aoi_upload_fail', {
        mode: variant,
        fileName: file.name,
        error: message,
      });
    } finally {
      setIsParsing(false);
      event.target.value = '';
    }
  };

  const handleStartDraw = () => {
    startAoiDraw();
    trackUxEvent('aoi_draw_start', { mode: variant });
  };

  const handleStartEdit = () => {
    const started = startAoiEdit();
    if (started) {
      trackUxEvent('aoi_edit_start', {
        mode: variant,
        source: effectiveAoi?.source || 'unknown',
        kind: effectiveAoi?.kind || 'unknown',
      });
    }
  };

  const handleApply = () => {
    const applied = applyDraftAoi();
    if (applied) {
      trackUxEvent('aoi_edit_apply', { mode: variant });
    }
  };

  const handleCancel = () => {
    cancelDraftAoi();
    trackUxEvent('aoi_edit_cancel', { mode: variant });
  };

  const actionRow = isAoiEditing ? (
    <div className={`aoi-upload-action-row ${variant}`}>
      <button
        type="button"
        className="aoi-upload-action-btn primary"
        disabled={!draftAOI?.geojson}
        onClick={handleApply}
      >
        Apply
      </button>
      <button
        type="button"
        className="aoi-upload-action-btn secondary"
        onClick={handleCancel}
      >
        Cancel
      </button>
    </div>
  ) : (
    <div className={`aoi-upload-action-row ${variant}`}>
      <button
        type="button"
        className="aoi-upload-action-btn primary"
        disabled={isParsing}
        onClick={openFilePicker}
      >
        {isParsing ? 'Uploading...' : 'Upload file'}
      </button>
      <button
        type="button"
        className="aoi-upload-action-btn secondary"
        disabled={isParsing}
        onClick={handleStartDraw}
      >
        Draw
      </button>
      <button
        type="button"
        className="aoi-upload-action-btn secondary"
        disabled={!hasEditableAoi || isParsing}
        onClick={handleStartEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="aoi-upload-action-btn secondary"
        disabled={!selectedAOI || isParsing}
        onClick={clearAoi}
      >
        Clear
      </button>
    </div>
  );

  return (
    <>
      {variant === 'agent' ? (
        <div className="control-section aoi-upload-inline-shell agent">
          <div className="section-header" onClick={() => setIsExpanded((value) => !value)}>
            <span className="section-title">Analysis Boundary</span>
            <span className={`expand-icon ${isExpanded ? 'expanded' : ''}`}>▼</span>
          </div>
          {isExpanded && <div className="section-body aoi-upload-inline-body">{actionRow}</div>}
        </div>
      ) : (
        <section className="aoi-upload-inline-shell ask">
          <div className="aoi-upload-heading-row">
            <h4 className="aoi-upload-heading">Analysis Boundary</h4>
          </div>
          {actionRow}
        </section>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json,.zip,application/geo+json,application/json,application/zip"
        onChange={handleFileChange}
        disabled={isAoiEditing}
        style={{ display: 'none' }}
      />
    </>
  );
}

export default AoiUploadPanel;
