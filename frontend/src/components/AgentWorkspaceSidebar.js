import React, { useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import AgentChatPane from './AgentChatPane';
import './AgentWorkspaceSidebar.css';

function AgentWorkspaceSidebar() {
  const {
    appMode,
    agentSidebarCollapsed,
    setAgentSidebarCollapsed,
  } = useAppContext();

  useEffect(() => {
    if (appMode !== 'agent') {
      setAgentSidebarCollapsed(false);
    }
  }, [appMode, setAgentSidebarCollapsed]);

  if (appMode !== 'agent') {
    return null;
  }

  return (
    <aside className={`agent-workspace-sidebar ${agentSidebarCollapsed ? 'is-collapsed' : ''}`}>
      <div className="agent-workspace-sidebar__header">
        {!agentSidebarCollapsed ? (
          <div className="agent-workspace-sidebar__title-block">
            <div className="agent-workspace-sidebar__eyebrow">Agent Workspace</div>
            <h2 className="agent-workspace-sidebar__title">Flood Analysis Chat</h2>
          </div>
        ) : null}

        <button
          type="button"
          className="agent-workspace-sidebar__collapse-btn"
          onClick={() => setAgentSidebarCollapsed((value) => !value)}
          aria-label={agentSidebarCollapsed ? 'Expand agent chat sidebar' : 'Collapse agent chat sidebar'}
          title={agentSidebarCollapsed ? 'Expand chat sidebar' : 'Collapse chat sidebar'}
        >
          <i className={`fa ${agentSidebarCollapsed ? 'fa-chevron-left' : 'fa-chevron-right'}`}></i>
        </button>
      </div>

      {!agentSidebarCollapsed ? (
        <div className="agent-workspace-sidebar__body">
          <AgentChatPane />
        </div>
      ) : null}
    </aside>
  );
}

export default AgentWorkspaceSidebar;
