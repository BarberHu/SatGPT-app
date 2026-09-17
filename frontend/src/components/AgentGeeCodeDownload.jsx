import React, { useCallback } from 'react';
import { trackUxEvent } from '../utils/analytics';

const downloadGEECode = (code, eventName) => {
  const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(eventName || 'flood_analysis').replace(/\s+/g, '_')}_GEE_${new Date().toISOString().split('T')[0]}.js`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export default function AgentGeeCodeDownload({
  code,
  eventName,
  disabledReason = null,
}) {
  const hasCode = Boolean(code);
  const handleDownload = useCallback(() => {
    if (!hasCode) {
      return;
    }
    trackUxEvent('export_gee_code', {
      event: eventName || null,
      mode: 'agent',
      source: 'agent_state',
    });
    downloadGEECode(code, eventName);
  }, [code, eventName, hasCode]);

  const title = hasCode
    ? 'Download Google Earth Engine JavaScript'
    : (disabledReason || 'GEE code is available after event dates and AOI are resolved');

  return (
    <div className="download-btn-div">
      <button
        type="button"
        className={`submit btn download ${!hasCode ? 'disabled' : ''}`}
        onClick={handleDownload}
        disabled={!hasCode}
        style={{
          cursor: hasCode ? 'pointer' : 'not-allowed',
          opacity: hasCode ? 1 : 0.5,
          pointerEvents: hasCode ? 'auto' : 'none',
        }}
        title={title}
      >
        DOWNLOAD GEE CODE
      </button>
    </div>
  );
}
