import React, { useCallback, useEffect } from 'react';
import { useCopilotContext } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import { trackUxEvent } from '../utils/analytics';
import AgentChatPane from './AgentChatPane';
import './AgentWorkspaceSidebar.css';

function AgentWorkspaceSidebar() {
  const {
    appMode,
    chatMode,
    agentSidebarCollapsed,
    setAgentSidebarCollapsed,
    resetAgentSession,
    startNewAgentSession,
    setWarning,
  } = useAppContext();
  const { setThreadId } = useCopilotContext();

  const handleNewChat = useCallback(() => {
    const newId = crypto.randomUUID();
    setThreadId(newId);
    startNewAgentSession({ preserveSelectedAoi: true });
    resetAgentSession({ preserveSelectedAoi: true });
    setWarning('');
    trackUxEvent('agent_new_chat', { mode: chatMode, entry: 'workspace_header' });
  }, [chatMode, resetAgentSession, setThreadId, setWarning, startNewAgentSession]);

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

        <div className="agent-workspace-sidebar__header-actions">
          {!agentSidebarCollapsed ? (
            <button
              type="button"
              className="agent-workspace-sidebar__icon-btn"
              onClick={handleNewChat}
              aria-label="Start a new agent conversation"
              title="New conversation"
            >
              <i className="fa fa-refresh"></i>
            </button>
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
