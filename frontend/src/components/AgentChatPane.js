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
import AgentAssistantMessage from './AgentAssistantMessage';
import AgentUserMessage from './AgentUserMessage';
import AoiUploadPanel from './AoiUploadPanel';
import './AgentChatPane.css';

const AGENT_MENTION_INSTRUCTIONS = `
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
The metadata only provides lightweight ids, labels, types, and sources. Do not treat it as raw geometry or as the full dataset payload.
For normal flood information questions, do not require an @ spatial scope. Answer using general reasoning and web/tool search when needed.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to run spatial execution, such as map rendering, satellite imagery retrieval, raster layers, impact analysis, or a confirmed analysis workflow tied to a user-defined AOI.
If spatial execution is requested without an explicit scope, ask for @ only at that point.
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
                initial: "Ask about a flood event. Add @ only when you want to run analysis for a specific spatial scope.",
                placeholder: "Enter flood event information...",
              }}
              suggestions={[
                {
                  title: "2024 Chiang Mai Flood",
                  message: "Tell me about the 2024 Chiang Mai flood event in Thailand",
                },
                {
                  title: "2021 Zhengzhou Flood",
                  message: "Tell me about the July 2021 Zhengzhou extreme rainfall event",
                },
                {
                  title: "2020 Jakarta Flood",
                  message: "Tell me about the January 2020 Jakarta flood event",
                },
              ]}
              className="agent-chat-pane__copilot"
              Input={renderAgentChatInput}
              AssistantMessage={AgentAssistantMessage}
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
