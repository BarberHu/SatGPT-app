/**
 * 来源侧边栏组件
 * 显示洪水事件的信息来源
 */

import React from 'react';
import { X, ExternalLink, Globe } from 'lucide-react';
import './SourcesDrawer.css';

function SourcesDrawer({ sources, isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="sources-drawer-overlay" onClick={onClose}>
      <div className="sources-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div className="header-title">
            <Globe size={18} />
            <h3>Sources</h3>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="drawer-content">
          {sources && sources.length > 0 ? (
            <ul className="sources-list">
              {sources.map((source, index) => (
                <li key={index} className="source-item">
                  <span className="source-number">{index + 1}</span>
                  <div className="source-info">
                    <a 
                      href={source.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="source-title"
                    >
                      {source.title}
                      <ExternalLink size={12} />
                    </a>
                    <span className="source-url">{source.url}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="no-sources">
              <Globe size={32} />
              <p>No sources available</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SourcesDrawer;
