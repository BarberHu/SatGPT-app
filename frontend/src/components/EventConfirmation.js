/**
 * 事件确认组件
 * 用于 Human-in-the-Loop 确认洪水事件信息
 */

import React, { useState } from 'react';
import { Calendar, MapPin, AlertTriangle, Check, X, Edit2 } from 'lucide-react';
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

  return (
    <div className="event-confirmation">
      <div className="confirmation-header">
        <AlertTriangle size={20} className="warning-icon" />
        <span>{message || '请确认以下洪水事件信息'}</span>
        <button className="edit-toggle" onClick={toggleEditMode} title={editMode ? "取消编辑" : "编辑"}>
          <Edit2 size={16} />
        </button>
      </div>

      <div className="confirmation-content">
        {/* 事件名称 */}
        <div className="field-group">
          <label>事件名称</label>
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

        {/* 事件描述 */}
        <div className="field-group">
          <label>事件描述</label>
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

        {/* 位置 */}
        <div className="field-group">
          <label>
            <MapPin size={14} />
            位置
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

        {/* 日期信息 */}
        <div className="dates-group">
          <div className="date-field">
            <label>
              <Calendar size={14} />
              洪水前
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
              洪峰期
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
              洪水后
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
          取消
        </button>
        <button className="btn-confirm" onClick={handleConfirm}>
          <Check size={16} />
          确认
        </button>
      </div>
    </div>
  );
}

export default EventConfirmation;
