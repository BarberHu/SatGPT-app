import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Check, Edit2, Info, Layers3, Loader2, MapPin, RefreshCcw, X } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import AoiUploadPanel from './AoiUploadPanel';
import { refreshFloodConfirmation } from '../services/agentApi';
import './EventConfirmation.css';

const buildEmptySelection = (layers = [], selectedLayerIds = []) =>
  (layers || []).reduce((accumulator, layer) => {
    accumulator[layer.id] = selectedLayerIds.length
      ? selectedLayerIds.includes(layer.id)
      : Boolean(layer.default_selected);
    return accumulator;
  }, {});

function EventConfirmation({ data, message, onConfirm, onCancel }) {
  const {
    selectedAOI,
    setSelectedAOI,
  } = useAppContext();
  const initialAoiRef = useRef(selectedAOI);
  const shouldRestoreAoiRef = useRef(true);
  const previousLocationRef = useRef(data?.location || '');

  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState(() => ({ ...data }));
  const [layerSelection, setLayerSelection] = useState(() => buildEmptySelection(data?.recommended_layers, data?.selected_layer_ids));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [isAoiStale, setIsAoiStale] = useState(false);

  useEffect(() => {
    setFormData({ ...data });
    setLayerSelection(buildEmptySelection(data?.recommended_layers, data?.selected_layer_ids));
    setIsAoiStale(false);
    setRefreshError('');
    previousLocationRef.current = data?.location || '';
    if (data?.confirmed_aoi || data?.resolved_aoi) {
      setSelectedAOI(data.confirmed_aoi || data.resolved_aoi);
    }
  }, [data, setSelectedAOI]);

  useEffect(() => () => {
    if (shouldRestoreAoiRef.current) {
      setSelectedAOI(initialAoiRef.current || null);
    }
  }, [setSelectedAOI]);

  const selectedLayerIds = useMemo(
    () => Object.entries(layerSelection).filter(([, checked]) => checked).map(([layerId]) => layerId),
    [layerSelection]
  );

  const activeAoi = selectedAOI || formData.confirmed_aoi || formData.resolved_aoi || null;
  const canConfirm = Boolean(activeAoi && selectedLayerIds.length && !isRefreshing && !isAoiStale);

  const handleFieldChange = (field, value) => {
    setFormData((previous) => ({
      ...previous,
      [field]: value,
    }));

    if (field === 'location') {
      const nextLocation = (value || '').trim();
      const locationChanged = nextLocation !== (previousLocationRef.current || '').trim();
      setIsAoiStale(locationChanged);
    }
  };

  const handleLayerToggle = (layerId) => {
    setLayerSelection((previous) => ({
      ...previous,
      [layerId]: !previous[layerId],
    }));
  };

  const handleAoiChange = (nextAoi) => {
    setFormData((previous) => ({
      ...previous,
      confirmed_aoi: nextAoi,
    }));
    if (nextAoi) {
      setSelectedAOI(nextAoi);
      setIsAoiStale(false);
      setRefreshError('');
    }
  };

  const handleRefreshBoundary = async () => {
    setIsRefreshing(true);
    setRefreshError('');
    try {
      const result = await refreshFloodConfirmation({
        event: formData.event,
        event_description: formData.event_description,
        location: formData.location,
        pre_date: formData.pre_date,
        peek_date: formData.peek_date,
        after_date: formData.after_date,
        confirmation_version: (formData.confirmation_version || 1) + 1,
      });

      if (!result?.success) {
        throw new Error('Spatial scope refresh failed.');
      }

      const nextData = result.data;
      setFormData((previous) => ({
        ...previous,
        ...nextData,
      }));
      setLayerSelection(buildEmptySelection(nextData.recommended_layers, nextData.selected_layer_ids));
      setSelectedAOI(nextData.confirmed_aoi || nextData.resolved_aoi || null);
      setIsAoiStale(false);
      previousLocationRef.current = nextData.location || formData.location || '';
    } catch (error) {
      setRefreshError(error?.message || 'Failed to refresh spatial scope.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConfirm = () => {
    if (!activeAoi) return;
    shouldRestoreAoiRef.current = false;
    onConfirm({
      ...formData,
      confirmed_aoi: activeAoi,
      resolved_aoi: formData.resolved_aoi || activeAoi,
      selected_layer_ids: selectedLayerIds,
      recommended_layers: formData.recommended_layers || [],
    });
  };

  const handleCancel = () => {
    shouldRestoreAoiRef.current = true;
    setSelectedAOI(initialAoiRef.current || null);
    onCancel();
  };

  const handleModalClick = (event) => {
    event.stopPropagation();
  };

  return (
    <div className="event-confirmation-overlay" onClick={handleCancel}>
      <div className="event-confirmation-modal unified-workbench" onClick={handleModalClick}>
        <div className="event-confirmation">
          <div className="confirmation-header">
            <div className="confirmation-header-main">
              <Info size={22} className="header-icon" />
              <span>{message || 'Confirm the flood event, spatial scope, and recommended datasets'}</span>
            </div>
            <button
              className="edit-toggle"
              onClick={() => setEditMode((previous) => !previous)}
              title={editMode ? 'Stop editing' : 'Edit fields'}
            >
              <Edit2 size={16} />
            </button>
          </div>

          <div className="confirmation-grid">
            <section className="confirmation-panel">
              <div className="panel-title">Event</div>

              <div className="field-group">
                <label>Event Name</label>
                {editMode ? (
                  <input
                    type="text"
                    value={formData.event || ''}
                    onChange={(event) => handleFieldChange('event', event.target.value)}
                  />
                ) : (
                  <span className="field-value">{formData.event}</span>
                )}
              </div>

              <div className="field-group">
                <label>Description</label>
                {editMode ? (
                  <textarea
                    rows={4}
                    value={formData.event_description || ''}
                    onChange={(event) => handleFieldChange('event_description', event.target.value)}
                  />
                ) : (
                  <span className="field-value description">{formData.event_description}</span>
                )}
              </div>

              <div className="field-group">
                <label>
                  <MapPin size={14} />
                  Location
                </label>
                {editMode ? (
                  <input
                    type="text"
                    value={formData.location || ''}
                    onChange={(event) => handleFieldChange('location', event.target.value)}
                  />
                ) : (
                  <span className="field-value">{formData.location}</span>
                )}
              </div>

              <div className="dates-group">
                {[
                  ['pre_date', 'Pre-Flood'],
                  ['peek_date', 'Peak'],
                  ['after_date', 'Post-Flood'],
                ].map(([field, label]) => (
                  <div className="date-field" key={field}>
                    <label>
                      <Calendar size={14} />
                      {label}
                    </label>
                    {editMode ? (
                      <input
                        type="date"
                        value={formData[field] || ''}
                        onChange={(event) => handleFieldChange(field, event.target.value)}
                      />
                    ) : (
                      <span className={`date-value ${field === 'peek_date' ? 'peek' : ''}`}>{formData[field]}</span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="confirmation-panel">
              <div className="panel-title">Spatial Scope</div>

              <div className="aoi-status-card">
                <div className="aoi-status-row">
                  <span>Status</span>
                  <strong>{formData.aoi_resolution_meta?.status || 'Scope pending'}</strong>
                </div>
                <div className="aoi-status-row">
                  <span>Source</span>
                  <strong>{formData.aoi_resolution_meta?.source || activeAoi?.source || 'manual'}</strong>
                </div>
                <div className="aoi-status-row">
                  <span>Confidence</span>
                  <strong>{typeof formData.aoi_resolution_meta?.confidence === 'number' ? `${Math.round(formData.aoi_resolution_meta.confidence * 100)}%` : 'N/A'}</strong>
                </div>
              </div>

              {activeAoi?.bounds && (
                <div className="aoi-bounds">
                  <div>W {activeAoi.bounds.west?.toFixed?.(4)} / E {activeAoi.bounds.east?.toFixed?.(4)}</div>
                  <div>S {activeAoi.bounds.south?.toFixed?.(4)} / N {activeAoi.bounds.north?.toFixed?.(4)}</div>
                </div>
              )}

              {isAoiStale && (
                <div className="confirmation-banner warning">
                  The scope is stale because the location text changed. Re-resolve or update it before confirming.
                </div>
              )}
              {refreshError && (
                <div className="confirmation-banner error">
                  {refreshError}
                </div>
              )}

              <div className="boundary-actions">
                <button
                  type="button"
                  className="aoi-upload-action-btn secondary"
                  onClick={handleRefreshBoundary}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? <Loader2 size={14} className="spin" /> : <RefreshCcw size={14} />}
                  Re-resolve scope
                </button>
              </div>

              <AoiUploadPanel variant="agent" onAoiChange={handleAoiChange} />
            </section>

            <section className="confirmation-panel">
              <div className="panel-title">
                <Layers3 size={16} />
                Recommended Layers
              </div>

              <div className="recommended-layers-list">
                {(formData.recommended_layers || []).map((layer) => (
                  <label key={layer.id} className="recommended-layer-item">
                    <input
                      type="checkbox"
                      checked={Boolean(layerSelection[layer.id])}
                      onChange={() => handleLayerToggle(layer.id)}
                    />
                    <div className="recommended-layer-copy">
                      <div className="recommended-layer-title">{layer.title}</div>
                      <div className="recommended-layer-meta">
                        <span>{layer.temporal_type}</span>
                        <span>{layer.spatial_scope}</span>
                        {layer.has_official_recipe ? <span>official style</span> : null}
                      </div>
                      {layer.summary ? (
                        <div className="recommended-layer-summary">{layer.summary}</div>
                      ) : null}
                    </div>
                  </label>
                ))}
                {!(formData.recommended_layers || []).length && (
                  <div className="no-recommendation-copy">Dataset unavailable for this region/time.</div>
                )}
              </div>
            </section>
          </div>

          <div className="confirmation-actions">
            <button className="btn-cancel" onClick={handleCancel}>
              <X size={16} />
              Cancel
            </button>
            <button className="btn-confirm" onClick={handleConfirm} disabled={!canConfirm}>
              <Check size={16} />
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default EventConfirmation;
