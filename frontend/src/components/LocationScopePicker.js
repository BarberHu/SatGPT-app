import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { searchLocationCandidates } from '../services/agentApi';
import './LocationScopePicker.css';

const PREVIEW_SOURCE = 'location_search_preview';
const IMPORT_SOURCE = 'place_search';

function buildPlaceScopeLabel(rawLabel) {
  const normalized = String(rawLabel || '').trim();
  if (!normalized) {
    return '';
  }

  const firstSegment = normalized
    .split(/[，,]/)[0]
    ?.trim();

  return firstSegment || normalized;
}

function normalizeImportedAoi(candidate) {
  const baseAoi = candidate?.resolved_aoi;
  if (!baseAoi?.geojson) {
    return null;
  }

  const nextId = `${IMPORT_SOURCE}:${candidate.id}`;
  const nextLabel = buildPlaceScopeLabel(
    candidate.label || baseAoi.label || candidate.location || 'Place scope'
  );

  return {
    ...baseAoi,
    id: nextId,
    source: IMPORT_SOURCE,
    origin: 'geocode',
    label: nextLabel,
    geojson: {
      ...baseAoi.geojson,
      properties: {
        ...(baseAoi.geojson?.properties || {}),
        id: nextId,
        label: nextLabel,
        source: IMPORT_SOURCE,
      },
    },
  };
}

function buildPreviewAoi(candidate) {
  const baseAoi = candidate?.resolved_aoi;
  if (!baseAoi?.geojson) {
    return null;
  }

  const nextId = `${PREVIEW_SOURCE}:${candidate.id}`;
  const nextLabel = buildPlaceScopeLabel(
    candidate.label || baseAoi.label || candidate.location || 'Preview scope'
  );

  return {
    ...baseAoi,
    id: nextId,
    source: PREVIEW_SOURCE,
    origin: 'geocode',
    label: nextLabel,
    geojson: {
      ...baseAoi.geojson,
      properties: {
        ...(baseAoi.geojson?.properties || {}),
        id: nextId,
        label: nextLabel,
        source: PREVIEW_SOURCE,
      },
    },
  };
}

function getFitPadding(dialogHeight, dialogWidth) {
  const topPadding = Math.max(120, Math.min(240, dialogHeight + 20));
  const rightPadding = Math.max(180, Math.min(480, dialogWidth + 36));
  return {
    top: topPadding,
    right: rightPadding,
    bottom: 72,
    left: 72,
  };
}

export default function LocationScopePicker({
  isOpen = true,
  onClose,
  embedded = false,
  showInlineNote = true,
}) {
  const {
    mapInstance,
    selectedAOI,
    setSelectedAOI,
    registerBusinessLayerFromAoi,
    setBusinessLayerActive,
    clearAgentVisualState,
    setWarning,
  } = useAppContext();

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [checkedIds, setCheckedIds] = useState([]);
  const [previewId, setPreviewId] = useState(null);
  const previousSelectedAoiRef = useRef(null);
  const pickerRef = useRef(null);

  const checkedSet = useMemo(() => new Set(checkedIds), [checkedIds]);
  const isVisible = embedded || isOpen;

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    previousSelectedAoiRef.current = selectedAOI || null;
    setError('');
    setCandidates([]);
    setCheckedIds([]);
    setPreviewId(null);
  }, [isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  const restorePreviousSelection = useCallback(() => {
    if (selectedAOI?.source !== PREVIEW_SOURCE) {
      return;
    }
    setSelectedAOI(previousSelectedAoiRef.current || null);
  }, [selectedAOI, setSelectedAOI]);

  const handleClose = useCallback(() => {
    restorePreviousSelection();
    onClose?.();
  }, [onClose, restorePreviousSelection]);

  const clearSearchResults = useCallback(() => {
    restorePreviousSelection();
    setCandidates([]);
    setCheckedIds([]);
    setPreviewId(null);
    setError('');
    setQuery('');
  }, [restorePreviousSelection]);

  useEffect(() => {
    if (!isOpen || embedded) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [embedded, handleClose, isOpen]);

  const previewCandidateOnMap = useCallback((candidate) => {
    const previewAoi = buildPreviewAoi(candidate);
    if (!previewAoi) {
      return;
    }

    setPreviewId(candidate.id);
    setSelectedAOI(previewAoi);

    if (mapInstance && previewAoi.bounds) {
      const { west, south, east, north } = previewAoi.bounds;
      const dialogHeight = pickerRef.current?.offsetHeight || 0;
      const dialogWidth = pickerRef.current?.offsetWidth || 0;
      mapInstance.fitBounds([[west, south], [east, north]], {
        padding: getFitPadding(dialogHeight, dialogWidth),
        duration: 700,
      });
    }
  }, [mapInstance, setSelectedAOI]);

  const handleSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setError('Please enter a place name.');
      return;
    }

    setLoading(true);
    setError('');
    setCandidates([]);
    setCheckedIds([]);
    setPreviewId(null);

    try {
      const response = await searchLocationCandidates({
        query: trimmedQuery,
        limit: 5,
      });

      const nextCandidates = response?.data || [];
      setCandidates(nextCandidates);

      if (!nextCandidates.length) {
        setError('No boundary candidates found. Try a more specific place name.');
        restorePreviousSelection();
        return;
      }

      previewCandidateOnMap(nextCandidates[0]);
    } catch (searchError) {
      setError(searchError?.message || 'Place search failed.');
      restorePreviousSelection();
    } finally {
      setLoading(false);
    }
  }, [previewCandidateOnMap, query, restorePreviousSelection]);

  const toggleChecked = useCallback((candidateId) => {
    setCheckedIds((previous) => (
      previous.includes(candidateId)
        ? previous.filter((id) => id !== candidateId)
        : [...previous, candidateId]
    ));
  }, []);

  const handleConfirm = useCallback(() => {
    const selectedCandidates = candidates.filter((candidate) => checkedSet.has(candidate.id));
    if (!selectedCandidates.length) {
      setError('Select at least one place before confirming.');
      return;
    }

    clearAgentVisualState();
    let firstImportedAoi = null;

    selectedCandidates.forEach((candidate) => {
      const importedAoi = normalizeImportedAoi(candidate);
      if (!importedAoi) {
        return;
      }

      if (!firstImportedAoi) {
        firstImportedAoi = importedAoi;
      }

      registerBusinessLayerFromAoi(importedAoi, {
        id: importedAoi.id,
        label: importedAoi.label,
        source: IMPORT_SOURCE,
        origin: 'geocode',
        markActive: false,
      });
    });

    if (!firstImportedAoi) {
      setError('The selected place could not be converted into a spatial scope.');
      return;
    }

    setBusinessLayerActive(firstImportedAoi.id);
    setSelectedAOI(firstImportedAoi);
    setWarning('');

    if (embedded) {
      setCandidates([]);
      setCheckedIds([]);
      setPreviewId(null);
      setQuery('');
    } else {
      onClose?.();
    }
  }, [
    candidates,
    checkedSet,
    clearAgentVisualState,
    embedded,
    onClose,
    registerBusinessLayerFromAoi,
    setBusinessLayerActive,
    setSelectedAOI,
    setWarning,
  ]);

  if (!isVisible) {
    return null;
  }

  const pickerContent = (
    <div
      ref={pickerRef}
      className={`location-scope-picker ${embedded ? 'embedded' : ''}`}
    >
      {!embedded ? (
        <div className="location-scope-picker-header">
          <div>
            <div className="location-scope-picker-title">Search Place</div>
            <div className="location-scope-picker-subtitle">
              Type a place name, preview candidate boundaries, then add the selected ones to Vector Layers.
            </div>
          </div>
          <button type="button" className="location-scope-picker-close" onClick={handleClose}>
            <i className="fa fa-times" aria-hidden="true" />
          </button>
        </div>
      ) : showInlineNote ? (
        <div className="location-scope-picker-inline-note">
          Search a place name, preview the boundary on the map, then add it to Vector Layers.
        </div>
      ) : null}

      <div className="location-scope-picker-search">
        <input
          type="text"
          className="location-scope-picker-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleSearch();
            }
          }}
          placeholder="e.g. Guangxi, China"
        />
        <button
          type="button"
          className="location-scope-picker-search-btn"
          onClick={handleSearch}
          disabled={loading}
          aria-label={loading ? 'Searching places' : 'Search places'}
          title={loading ? 'Searching' : 'Search'}
        >
          {loading ? (
            <span className="location-scope-picker-search-spinner" aria-hidden="true" />
          ) : (
            <Search size={16} strokeWidth={2.4} aria-hidden="true" />
          )}
        </button>
      </div>

      {error ? <div className="location-scope-picker-feedback error">{error}</div> : null}

      {candidates.length ? (
        <div className="location-scope-picker-results">
          {candidates.map((candidate) => {
            const isChecked = checkedSet.has(candidate.id);
            const isPreviewing = previewId === candidate.id;

            return (
              <div
                key={candidate.id}
                className={`location-scope-candidate ${isPreviewing ? 'previewing' : ''}`}
              >
                <button
                  type="button"
                  className="location-scope-candidate-main"
                  onClick={() => previewCandidateOnMap(candidate)}
                >
                  <span className="location-scope-candidate-title">{candidate.label}</span>
                  <span className="location-scope-candidate-meta">
                    {candidate.source}
                    {candidate.raw_type ? ` - ${candidate.raw_type}` : ''}
                  </span>
                </button>
                <label className="location-scope-candidate-check">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleChecked(candidate.id)}
                  />
                  <span>Add</span>
                </label>
              </div>
            );
          })}
        </div>
      ) : null}

      {candidates.length ? (
        <div className="location-scope-picker-actions">
          <button
            type="button"
            className="location-scope-picker-action secondary"
            onClick={embedded ? clearSearchResults : handleClose}
          >
            {embedded ? 'Reset' : 'Cancel'}
          </button>
          <button
            type="button"
            className="location-scope-picker-action primary"
            onClick={handleConfirm}
            disabled={!checkedIds.length}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );

  if (embedded) {
    return pickerContent;
  }

  return createPortal(
    <div className="location-scope-picker-overlay">
      {pickerContent}
    </div>,
    document.body
  );
}
