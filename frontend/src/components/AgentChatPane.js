import React, { Profiler, useCallback, useMemo, useRef } from 'react';
import { CopilotChat } from "@copilotkit/react-ui";
import { useAppContext } from '../context/AppContext';
import { trackUxEvent } from '../utils/analytics';
import {
  createReactProfilerHandler,
  logAgentDiagnostic,
  useRenderDiagnostics,
} from '../utils/agentDiagnostics';
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
  } = useAppContext();
  const paneProfiler = useMemo(
    () => createReactProfilerHandler('AgentChatPane', () => ({ chatMode })),
    [chatMode]
  );
  const copilotChatProfiler = useMemo(
    () => createReactProfilerHandler('CopilotChat', () => ({ chatMode })),
    [chatMode]
  );

  useRenderDiagnostics('AgentChatPane', () => ({
    chatMode,
  }));

  const handleOpenSpatialUpload = useCallback(() => {
    uploadPanelRef.current?.openFilePicker?.();
    trackUxEvent('agent_scope_upload_open', { mode: 'agent', entry: 'chat_sidebar' });
  }, []);

  const renderAgentChatInput = useCallback((inputProps) => (
    <AgentChatInput
      {...inputProps}
      onOpenSpatialUpload={handleOpenSpatialUpload}
    />
  ), [handleOpenSpatialUpload]);

  return (
    <Profiler id="AgentChatPane" onRender={paneProfiler}>
      <div className="agent-chat-pane">
        <div className="agent-chat-pane__messages">
          <Profiler id="CopilotChat" onRender={copilotChatProfiler}>
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
              Input={renderAgentChatInput}
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
                logAgentDiagnostic('copilot', 'chat_error', {
                  message: copilotError?.message || 'unknown',
                  chatMode,
                });
              }}
            />
          </Profiler>
        </div>

        <AoiUploadPanel
          ref={uploadPanelRef}
          variant="agent"
          presentation="hidden"
          lightweight
        />
      </div>
    </Profiler>
  );
}

export default AgentChatPane;
