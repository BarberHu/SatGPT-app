import React, { useMemo, useRef, useState } from 'react';
import shp from 'shpjs';
import { useAppContext } from '../context/AppContext';
import { buildAoiFromGeoJSON, getAoiLabel } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';

function AoiUploadPanel() {
  const fileInputRef = useRef(null);
  const [isParsing, setIsParsing] = useState(false);

  const {
    selectedAOI,
    setSelectedAOI,
    setSelectedGridCords,
    setWarning,
    appMode,
    resetAgentSession,
    resetAskSession,
  } = useAppContext();

  const aoiLabel = useMemo(() => getAoiLabel(selectedAOI), [selectedAOI]);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const clearAoi = () => {
    resetAskSession();
    setSelectedAOI(null);
    setSelectedGridCords(null);
    setWarning('');
    resetAgentSession({ preserveSelectedAoi: false });
    trackUxEvent('aoi_clear', { mode: appMode });
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
      resetAgentSession({ preserveSelectedAoi: true });
      trackUxEvent('aoi_upload_success', {
        mode: appMode,
        fileName: file.name,
        source: aoi.source,
        kind: aoi.kind,
      });
    } catch (error) {
      const message = error?.message || 'Boundary parsing failed.';
      setWarning(message);
      trackUxEvent('aoi_upload_fail', {
        mode: appMode,
        fileName: file.name,
        error: message,
      });
    } finally {
      setIsParsing(false);
      event.target.value = '';
    }
  };

  return (
    <section className="aoi-upload-panel">
      <div className="aoi-upload-header">
        <div>
          <h3>Analysis Boundary</h3>
          <p>Fishnet click and file upload now share one AOI pipeline.</p>
        </div>
        {selectedAOI && (
          <span className="aoi-badge">
            {selectedAOI.source === 'upload' ? 'Uploaded' : selectedAOI.source}
          </span>
        )}
      </div>

      <div className="aoi-upload-body">
        <div className="aoi-status-card">
          <span className="aoi-status-label">Current AOI</span>
          <strong className="aoi-status-value">{aoiLabel}</strong>
          {selectedAOI?.bounds && (
            <span className="aoi-status-meta">
              W {selectedAOI.bounds.west.toFixed(2)} / E {selectedAOI.bounds.east.toFixed(2)} / S {selectedAOI.bounds.south.toFixed(2)} / N {selectedAOI.bounds.north.toFixed(2)}
            </span>
          )}
          {appMode === 'agent' && selectedAOI && (
            <span className="aoi-status-hint">Agent mode will prioritize this manual boundary.</span>
          )}
        </div>

        <div className="aoi-upload-actions">
          <button
            type="button"
            className="aoi-btn primary"
            disabled={isParsing}
            onClick={openFilePicker}
          >
            {isParsing ? 'Parsing boundary...' : 'Upload GeoJSON / ZIP Shapefile'}
          </button>
          <button
            type="button"
            className="aoi-btn secondary"
            disabled={!selectedAOI || isParsing}
            onClick={clearAoi}
          >
            Clear AOI
          </button>
        </div>

        <p className="aoi-upload-hint">
          Supported formats: <code>.geojson</code>, <code>.json</code>, <code>.zip</code>. The map fishnet is still available for quick selection.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json,.zip,application/geo+json,application/json,application/zip"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
    </section>
  );
}

export default AoiUploadPanel;
