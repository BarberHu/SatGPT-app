import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, Check, Edit2, Info, MapPin, X } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { buildAoiFromBounds, buildAoiFromGeoJSON } from '../utils/aoi';
import AoiUploadPanel from './AoiUploadPanel';
import SourcesDrawer from './SourcesDrawer';
import './EventConfirmation.css';

const formatBounds = (bounds) => {
  if (!bounds) return 'No boundary selected';
  const { west, south, east, north } = bounds;
  return `W ${west.toFixed(3)} | S ${south.toFixed(3)} | E ${east.toFixed(3)} | N ${north.toFixed(3)}`;
};

const centerFromBounds = (bounds) => {
  if (!bounds) return null;
  return [
    Number(((bounds.west + bounds.east) / 2).toFixed(6)),
    Number(((bounds.south + bounds.north) / 2).toFixed(6)),
  ];
};

function EventConfirmation({ data, message, onConfirm, onCancel }) {
  const [editMode, setEditMode] = useState(false);
  const [editedData, setEditedData] = useState({ ...data });
  const [selectedAssetIds, setSelectedAssetIds] = useState(
    data?.preselected_asset_ids?.length
      ? data.preselected_asset_ids
      : (data?.recommended_assets || []).slice(0, 1).map((asset) => asset.asset_id)
  );
  const [sourcesDrawerOpen, setSourcesDrawerOpen] = useState(false);

  const {
    selectedAOI,
    draftAOI,
    setSelectedAOI,
    cancelDraftAoi,
  } = useAppContext();

  useEffect(() => {
    setEditedData({ ...data });
    setSelectedAssetIds(
      data?.preselected_asset_ids?.length
        ? data.preselected_asset_ids
        : (data?.recommended_assets || []).slice(0, 1).map((asset) => asset.asset_id)
    );
  }, [data]);

  const initialAoi = useMemo(() => {
    if (data?.geojson) {
      return buildAoiFromGeoJSON(data.geojson, {
        source: data.aoi_source || 'agent_geocode',
        label: data.location || 'Agent-derived boundary',
      });
    }
    if (data?.bounds) {
      return buildAoiFromBounds(data.bounds, {
        source: data.aoi_source || 'agent_geocode',
        label: data.location || 'Agent-derived boundary',
      });
    }
    return null;
  }, [data]);

  useEffect(() => {
    if (initialAoi && !draftAOI) {
      setSelectedAOI(initialAoi);
    }
  }, [draftAOI, initialAoi, selectedAOI, setSelectedAOI]);

  const effectiveAoi = draftAOI || selectedAOI || initialAoi;

  const drawerSources = useMemo(
    () => (editedData?.recommended_assets || []).map((asset) => ({
      title: asset.title,
      url: asset.official_url,
      asset_id: asset.asset_id,
      summary: asset.summary,
      notes: asset.notes,
    })),
    [editedData?.recommended_assets]
  );

  const handleFieldChange = (field, value) => {
    setEditedData((previous) => ({
      ...previous,
      [field]: value,
    }));
  };

  const handleToggleAsset = (assetId) => {
    setSelectedAssetIds((previous) => (
      previous.includes(assetId)
        ? previous.filter((item) => item !== assetId)
        : [...previous, assetId]
    ));
  };

  const handleConfirm = () => {
    const finalBounds = effectiveAoi?.bounds || editedData.bounds || null;
    const finalCoordinates = editedData.coordinates || centerFromBounds(finalBounds);

    onConfirm({
      ...editedData,
      selected_asset_ids: selectedAssetIds,
      bounds: finalBounds,
      geojson: effectiveAoi?.geojson || editedData.geojson || null,
      coordinates: finalCoordinates,
      aoi_source: effectiveAoi?.source || editedData.aoi_source || null,
    });
  };

  const handleCancel = () => {
    cancelDraftAoi();
    onCancel();
  };

  const handleModalClick = (event) => {
    event.stopPropagation();
  };

  return (
    <div className="event-confirmation-overlay" onClick={handleCancel}>
      <div className="event-confirmation-modal" onClick={handleModalClick}>
        <SourcesDrawer
          sources={drawerSources}
          isOpen={sourcesDrawerOpen}
          onClose={() => setSourcesDrawerOpen(false)}
        />

        <div className="event-confirmation">
          <div className="confirmation-header">
            <Info size={22} className="header-icon" />
            <span>{message || 'Please confirm the event details, analysis boundary, and map layers.'}</span>
            <button
              className="edit-toggle"
              onClick={() => setEditMode((value) => !value)}
              title={editMode ? 'Stop editing fields' : 'Edit fields'}
            >
              <Edit2 size={16} />
            </button>
          </div>

          <div className="confirmation-content">
            <section className="confirmation-section">
              <div className="confirmation-section-title">Event Info</div>

              <div className="field-group">
                <label>Event Name</label>
                {editMode ? (
                  <input
                    type="text"
                    value={editedData.event || ''}
                    onChange={(event) => handleFieldChange('event', event.target.value)}
                  />
                ) : (
                  <span className="field-value">{editedData.event}</span>
                )}
              </div>

              <div className="field-group">
                <label>Description</label>
                {editMode ? (
                  <textarea
                    value={editedData.event_description || ''}
                    onChange={(event) => handleFieldChange('event_description', event.target.value)}
                    rows={4}
                  />
                ) : (
                  <span className="field-value description">{editedData.event_description}</span>
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
                    value={editedData.location || ''}
                    onChange={(event) => handleFieldChange('location', event.target.value)}
                  />
                ) : (
                  <span className="field-value">{editedData.location}</span>
                )}
              </div>

              <div className="dates-group">
                <div className="date-field">
                  <label>
                    <Calendar size={14} />
                    Pre-Flood
                  </label>
                  {editMode ? (
                    <input
                      type="date"
                      value={editedData.pre_date || ''}
                      onChange={(event) => handleFieldChange('pre_date', event.target.value)}
                    />
                  ) : (
                    <span className="date-value">{editedData.pre_date}</span>
                  )}
                </div>

                <div className="date-field">
                  <label>
                    <Calendar size={14} />
                    Peak
                  </label>
                  {editMode ? (
                    <input
                      type="date"
                      value={editedData.peek_date || ''}
                      onChange={(event) => handleFieldChange('peek_date', event.target.value)}
                    />
                  ) : (
                    <span className="date-value peek">{editedData.peek_date}</span>
                  )}
                </div>

                <div className="date-field">
                  <label>
                    <Calendar size={14} />
                    Post-Flood
                  </label>
                  {editMode ? (
                    <input
                      type="date"
                      value={editedData.after_date || ''}
                      onChange={(event) => handleFieldChange('after_date', event.target.value)}
                    />
                  ) : (
                    <span className="date-value">{editedData.after_date}</span>
                  )}
                </div>
              </div>
            </section>

            <section className="confirmation-section">
              <div className="confirmation-section-title">Analysis Boundary</div>
              <div className="aoi-summary-card">
                <div className="aoi-summary-row">
                  <span className="aoi-summary-label">Source</span>
                  <span className="aoi-summary-value">{effectiveAoi?.source || editedData.aoi_source || 'Not set'}</span>
                </div>
                <div className="aoi-summary-row">
                  <span className="aoi-summary-label">Type</span>
                  <span className="aoi-summary-value">{effectiveAoi?.kind || 'None'}</span>
                </div>
                <div className="aoi-summary-row">
                  <span className="aoi-summary-label">Bounds</span>
                  <span className="aoi-summary-value">{formatBounds(effectiveAoi?.bounds || editedData.bounds)}</span>
                </div>
              </div>
              <AoiUploadPanel variant="modal" />
            </section>

            <section className="confirmation-section">
              <div className="confirmation-section-headline">
                <div className="confirmation-section-title">Recommended Layers</div>
                <button
                  type="button"
                  className="secondary-link-btn"
                  onClick={() => setSourcesDrawerOpen(true)}
                >
                  View Sources
                </button>
              </div>

              <div className="dataset-list compact">
                {(editedData.recommended_assets || []).map((asset) => {
                  const checked = selectedAssetIds.includes(asset.asset_id);
                  return (
                    <label
                      key={asset.asset_id}
                      className={`dataset-card selectable ${checked ? 'selected' : ''}`}
                    >
                      <div className="dataset-select-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleAsset(asset.asset_id)}
                        />
                        <div className="dataset-title">{asset.title}</div>
                      </div>
                      <div className="dataset-id">{asset.asset_id}</div>
                      <div className="dataset-summary">{asset.summary}</div>
                      <div className="dataset-badges">
                        {(asset.themes || []).map((theme) => (
                          <span key={`${asset.asset_id}-${theme}`} className="dataset-badge">{theme}</span>
                        ))}
                        {asset.temporal_type && (
                          <span className="dataset-badge dataset-badge-muted">{asset.temporal_type}</span>
                        )}
                      </div>
                      {asset.notes && <div className="dataset-note">{asset.notes}</div>}
                    </label>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="confirmation-actions">
            <button className="btn-cancel" onClick={handleCancel}>
              <X size={16} />
              Cancel
            </button>
            <button className="btn-confirm" onClick={handleConfirm}>
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
