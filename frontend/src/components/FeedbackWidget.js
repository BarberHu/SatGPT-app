import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { clearUxEvents, downloadUxEvents, readUxEvents, trackUxEvent } from '../utils/analytics';

const DEFAULT_FORM = {
  task: 'agent-event-analysis',
  easeScore: '3',
  confidenceScore: '3',
  notes: '',
};

function FeedbackWidget() {
  const { appMode } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const eventCount = readUxEvents().length;

  const toggleOpen = () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    trackUxEvent('feedback_widget_toggle', { open: nextOpen, mode: appMode });
  };

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveFeedback = () => {
    trackUxEvent('ux_feedback_submit', {
      mode: appMode,
      ...form,
    });
    setForm(DEFAULT_FORM);
  };

  const exportFeedback = () => {
    downloadUxEvents();
    trackUxEvent('ux_feedback_export', { mode: appMode });
  };

  const clearFeedback = () => {
    clearUxEvents();
    trackUxEvent('ux_feedback_clear', { mode: appMode });
  };

  return (
    <div className={`feedback-widget ${isOpen ? 'open' : ''}`}>
      <button type="button" className="feedback-trigger" onClick={toggleOpen}>
        UX Feedback
      </button>

      {isOpen && (
        <div className="feedback-card">
          <div className="feedback-card-header">
            <div>
              <strong>Test Capture</strong>
              <p>Record task friction while users are still in context.</p>
            </div>
            <span className="feedback-count">{eventCount} events</span>
          </div>

          <label>
            Task
            <select value={form.task} onChange={(event) => updateField('task', event.target.value)}>
              <option value="ask-single-event">Ask: Single inundation</option>
              <option value="ask-hotspot">Ask: Hotspot analysis</option>
              <option value="agent-event-analysis">Agent: Event analysis</option>
              <option value="agent-manual-aoi">Agent: Manual boundary override</option>
            </select>
          </label>

          <label>
            Ease score (1 hard - 5 easy)
            <input
              type="range"
              min="1"
              max="5"
              value={form.easeScore}
              onChange={(event) => updateField('easeScore', event.target.value)}
            />
          </label>

          <label>
            Confidence score (1 low - 5 high)
            <input
              type="range"
              min="1"
              max="5"
              value={form.confidenceScore}
              onChange={(event) => updateField('confidenceScore', event.target.value)}
            />
          </label>

          <label>
            Observation
            <textarea
              rows={4}
              placeholder="Which step slowed the user down? What confused them?"
              value={form.notes}
              onChange={(event) => updateField('notes', event.target.value)}
            />
          </label>

          <div className="feedback-actions">
            <button type="button" className="feedback-btn primary" onClick={saveFeedback}>
              Save feedback
            </button>
            <button type="button" className="feedback-btn secondary" onClick={exportFeedback}>
              Export JSON
            </button>
            <button type="button" className="feedback-btn ghost" onClick={clearFeedback}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default FeedbackWidget;
