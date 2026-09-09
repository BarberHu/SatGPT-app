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

export default function AgentGeeCodeDownload({ code, eventName }) {
  const handleDownload = useCallback(() => {
    if (!code) {
      return;
    }
    trackUxEvent('export_gee_code', {
      event: eventName || null,
      mode: 'agent',
      source: 'agent_state',
    });
    downloadGEECode(code, eventName);
  }, [code, eventName]);

  return (
    <div className="download-btn-div">
      <button
        type="button"
        className={`submit btn download ${!code ? 'disabled' : ''}`}
        onClick={handleDownload}
        disabled={!code}
        style={{
          cursor: code ? 'pointer' : 'not-allowed',
          opacity: code ? 1 : 0.5,
          pointerEvents: code ? 'auto' : 'none',
        }}
        title={code
          ? 'Download Google Earth Engine JavaScript'
          : 'GEE code is available after event dates and AOI are resolved'}
      >
        DOWNLOAD GEE CODE
      </button>
    </div>
  );
}
