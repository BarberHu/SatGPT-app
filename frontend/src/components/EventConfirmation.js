import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Check, Edit2, Info, Layers3, MapPin, X } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
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

  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState(() => ({ ...data }));
  const [layerSelection, setLayerSelection] = useState(() => buildEmptySelection(data?.recommended_layers, data?.selected_layer_ids));

  useEffect(() => {
    setFormData({ ...data });
    setLayerSelection(buildEmptySelection(data?.recommended_layers, data?.selected_layer_ids));
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
  const canConfirm = Boolean(activeAoi && selectedLayerIds.length);

  const handleFieldChange = (field, value) => {
    setFormData((previous) => ({
      ...previous,
      [field]: value,
    }));
  };

  const handleLayerToggle = (layerId) => {
    setLayerSelection((previous) => ({
      ...previous,
      [layerId]: !previous[layerId],
    }));
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

  return createPortal(
    <div className="event-confirmation-overlay" onClick={handleCancel}>
      <div className="event-confirmation-modal unified-workbench" onClick={handleModalClick}>
        <div className="event-confirmation">
          <div className="confirmation-header">
            <div className="confirmation-header-main">
              <Info size={22} className="header-icon" />
              <span>{message || 'Confirm the flood event and recommended datasets'}</span>
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
                <span className="field-value">{formData.location}</span>
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
              <div className="panel-title">
                <Layers3 size={16} />
                Recommended Layers
              </div>
              {formData.recommendation_strategy ? (
                <div className="recommendation-strategy">
                  {formData.recommendation_strategy}
                </div>
              ) : null}

              <div className="recommended-layers-list">
                {(formData.recommended_layers || []).map((layer) => {
                  const checked = Boolean(layerSelection[layer.id]);
                  const recommendationReason = layer.recommendation_reason || layer.when_to_use || layer.summary;
                  const riskNotes = layer.risk_notes || layer.when_not_to_use;

                  return (
                    <label
                      key={layer.id}
                      className={`recommended-layer-item ${checked ? 'is-selected' : ''}`}
                    >
                      <input
                        className="event-confirmation-checkbox"
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleLayerToggle(layer.id)}
                      />
                      <div className="recommended-layer-copy">
                        <div className="recommended-layer-title">{layer.title}</div>
                        <div className="recommended-layer-meta">
                          <span>{layer.temporal_type}</span>
                          <span>{layer.spatial_scope}</span>
                          {layer.has_official_recipe ? <span>official style</span> : null}
                        </div>
                        {recommendationReason ? (
                          <div className="recommended-layer-summary">{recommendationReason}</div>
                        ) : null}
                        {riskNotes ? (
                          <div className="recommended-layer-summary muted">{riskNotes}</div>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
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
    </div>,
    document.body
  );
}

export default EventConfirmation;
