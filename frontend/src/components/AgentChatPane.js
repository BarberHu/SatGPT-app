import React, { useCallback, useRef } from 'react';
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotContext } from "@copilotkit/react-core";
import { useAppContext } from '../context/AppContext';
import { trackUxEvent } from '../utils/analytics';
import AgentChatInput from './AgentChatInput';
import AgentUserMessage from './AgentUserMessage';
import AoiUploadPanel from './AoiUploadPanel';
import './AgentChatPane.css';

const AGENT_MENTION_INSTRUCTIONS = `
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
The metadata only provides lightweight ids, labels, types, and sources. Do not treat it as raw geometry or as the full dataset payload.
For spatial execution, only trust explicit uploaded or drawn scope mentions that resolve from the synced business layer store.
If no explicit spatial mention is present, ask the user to provide one instead of silently falling back to a location-derived boundary.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

function AgentChatPane() {
  const uploadPanelRef = useRef(null);
  const {
    chatMode,
    setChatMode,
    setAppMode,
    setChatInput,
    setWarning,
    resetAgentSession,
    startNewAgentSession,
  } = useAppContext();
  const { setThreadId } = useCopilotContext();

  const handleOpenSpatialUpload = useCallback(() => {
    uploadPanelRef.current?.openFilePicker?.();
    trackUxEvent('agent_scope_upload_open', { mode: 'agent', entry: 'chat_sidebar' });
  }, []);

  const handleNewChat = () => {
    const newId = crypto.randomUUID();
    setThreadId(newId);
    startNewAgentSession({ preserveSelectedAoi: true });
    resetAgentSession({ preserveSelectedAoi: true });
    setWarning('');
    trackUxEvent('agent_new_chat', { mode: chatMode });
  };

  const handleModeToggle = (mode) => {
    if (mode !== chatMode) {
      trackUxEvent('mode_switch', { from: chatMode, to: mode });
      if (chatMode === 'agent' || mode === 'agent') {
        resetAgentSession({ preserveSelectedAoi: true });
      }
    }

    setChatMode(mode);
    setAppMode(mode);
    setChatInput('');
    setWarning('');
  };

  return (
    <div className="agent-chat-pane">
      <div className="agent-chat-pane__messages">
        <CopilotChat
          instructions={AGENT_MENTION_INSTRUCTIONS}
          labels={{
            title: "Flood Analysis Agent",
            initial: "Describe a flood event, then type @ to attach an uploaded or drawn spatial scope.",
            placeholder: "Enter flood event information...",
          }}
          suggestions={[
            {
              title: "2024 Chiang Mai Flood",
              message: "Please analyze the 2024 Chiang Mai flood event in Thailand",
            },
            {
              title: "2021 Zhengzhou Flood",
              message: "Please analyze the July 2021 Zhengzhou extreme rainfall event",
            },
            {
              title: "2020 Jakarta Flood",
              message: "Please analyze the January 2020 Jakarta flood event",
            },
          ]}
          className="agent-chat-pane__copilot"
          Input={AgentChatInput}
          UserMessage={AgentUserMessage}
          onError={(copilotError) => {
            if (
              copilotError?.message?.includes('aborted')
              || copilotError?.message?.includes('Aborted')
            ) {
              console.log('Operation cancelled');
              return;
            }
            console.error('Chat error:', copilotError);
          }}
        />
      </div>

      <div className="agent-chat-pane__toolbar">
        <div className="agent-chat-pane__toolbar-left">
          <button
            type="button"
            className="agent-chat-pane__icon-btn"
            title="New conversation"
            onClick={handleNewChat}
          >
            <i className="fa fa-plus"></i>
          </button>
          <button
            type="button"
            className="agent-chat-pane__text-btn"
            title="Upload Scope"
            onClick={handleOpenSpatialUpload}
          >
            Upload
          </button>
        </div>

        <div className="agent-chat-pane__toolbar-right">
          <div className="agent-chat-pane__mode-toggle">
            <button
              type="button"
              className={`agent-chat-pane__mode-btn ${chatMode === 'ask' ? 'active' : ''}`}
              onClick={() => handleModeToggle('ask')}
            >
              Ask
            </button>
            <button
              type="button"
              className={`agent-chat-pane__mode-btn ${chatMode === 'agent' ? 'active' : ''}`}
              onClick={() => handleModeToggle('agent')}
            >
              Agent
            </button>
          </div>
        </div>
      </div>

      <AoiUploadPanel
        ref={uploadPanelRef}
        variant="agent"
        presentation="hidden"
        lightweight
      />
    </div>
  );
}

export default AgentChatPane;
