/**
 * Event Confirmation Component (Modal)
 * Used for Human-in-the-Loop confirmation of flood event information
 */

import React, { useState } from 'react';
import { Calendar, MapPin, Info, Check, X, Edit2 } from 'lucide-react';
import './EventConfirmation.css';

function EventConfirmation({ data, message, onConfirm, onCancel }) {
  const [editMode, setEditMode] = useState(false);
  const [editedData, setEditedData] = useState({ ...data });

  const handleFieldChange = (field, value) => {
    setEditedData(prev => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleConfirm = () => {
    onConfirm(editedData);
  };

  const handleCancel = () => {
    onCancel();
  };

  const toggleEditMode = () => {
    setEditMode(!editMode);
  };

  // Prevent closing modal when clicking inside
  const handleModalClick = (e) => {
    e.stopPropagation();
  };

  return (
    <div className="event-confirmation-overlay" onClick={handleCancel}>
      <div className="event-confirmation-modal" onClick={handleModalClick}>
        <div className="event-confirmation">
          <div className="confirmation-header">
            <Info size={22} className="header-icon" />
            <span>{message || 'Please confirm the flood event information'}</span>
            <button 
              className="edit-toggle" 
              onClick={toggleEditMode} 
              title={editMode ? "Cancel edit" : "Edit"}
            >
              <Edit2 size={16} />
            </button>
          </div>

          <div className="confirmation-content">
            {/* Event Name */}
            <div className="field-group">
              <label>Event Name</label>
              {editMode ? (
                <input
                  type="text"
                  value={editedData.event || ''}
                  onChange={(e) => handleFieldChange('event', e.target.value)}
                />
              ) : (
                <span className="field-value">{editedData.event}</span>
              )}
            </div>

            {/* Event Description */}
            <div className="field-group">
              <label>Description</label>
              {editMode ? (
                <textarea
                  value={editedData.event_description || ''}
                  onChange={(e) => handleFieldChange('event_description', e.target.value)}
                  rows={3}
                />
              ) : (
                <span className="field-value description">{editedData.event_description}</span>
              )}
            </div>

            {/* Location */}
            <div className="field-group">
              <label>
                <MapPin size={14} />
                Location
              </label>
              {editMode ? (
                <input
                  type="text"
                  value={editedData.location || ''}
                  onChange={(e) => handleFieldChange('location', e.target.value)}
                />
              ) : (
                <span className="field-value">{editedData.location}</span>
              )}
            </div>

            {/* Date Information */}
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
                    onChange={(e) => handleFieldChange('pre_date', e.target.value)}
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
                    onChange={(e) => handleFieldChange('peek_date', e.target.value)}
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
                    onChange={(e) => handleFieldChange('after_date', e.target.value)}
                  />
                ) : (
                  <span className="date-value">{editedData.after_date}</span>
                )}
              </div>
            </div>
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
