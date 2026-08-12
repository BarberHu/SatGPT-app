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

const WILDFIRE_MENTION_INSTRUCTIONS = `
The current wildfire module is a frontend prototype for integration review. Do not claim that real wildfire execution, wildfire APIs, or wildfire agent tools are already wired unless the user explicitly provides those services.
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
For wildfire readiness questions, focus on required datasets, layer contracts, legends, AOI handling, map tile endpoints, and agent tool boundaries.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to run spatial execution, such as fire perimeter analysis, active-fire rendering, burn severity mapping, exposure analysis, or AOI-tied wildfire workflows.
If spatial execution is requested without an explicit scope, ask for @ only at that point.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

const LANDSLIDE_MENTION_INSTRUCTIONS = `
The current landslide module is a frontend prototype for integration review. It can render default terrain/context raster layers, but do not claim that landslide susceptibility modeling or landslide agent tools are fully wired.
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
For landslide readiness questions, focus on slope, elevation, land cover, rainfall triggers, exposure layers, AOI handling, map tile endpoints, and agent tool boundaries.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to run spatial execution, such as slope rendering, susceptibility mapping, exposure analysis, or AOI-tied landslide workflows.
If spatial execution is requested without an explicit scope, ask for @ only at that point.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

const CONTEXT_MENTION_INSTRUCTIONS = `
The current context module is a shared raster-layer workspace for common AOI background data such as population density, soil texture, and land cover.
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
Do not present this module as a disaster-specific analysis agent. Explain it as reusable context evidence that can support flood, wildfire, and landslide workflows.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to render or load AOI-tied context layers.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

const IMAGERY_MENTION_INSTRUCTIONS = `
The current imagery module is a shared workspace for AOI-tied optical and SAR imagery layers.
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
Do not present this module as a disaster-specific analysis agent. Explain it as reusable satellite evidence that can support flood, wildfire, landslide, and context workflows.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to render or load satellite imagery for a selected AOI.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

const VECTOR_MENTION_INSTRUCTIONS = `
The current vector module is a shared workspace for uploaded, drawn, searched, or edited spatial scopes.
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
Do not present this module as a disaster-specific analysis agent. Explain it as the reusable AOI and business-layer manager that can constrain flood, wildfire, landslide, imagery, and context workflows.
Only require an explicit uploaded or drawn @ spatial scope when the user asks to run spatial execution against a specific vector layer.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

function AgentChatPane() {
  const uploadPanelRef = useRef(null);
  const {
    agentModule,
    chatMode,
  } = useAppContext();
  const chatCopy = useMemo(() => (
    {
      wildfire: {
        labels: {
          title: "Wildfire Analysis Agent",
          initial: "Explore wildfire risk, burn history, burn severity, and exposure layers. This prototype still needs real wildfire data services before execution.",
          placeholder: "Enter wildfire event or module integration question...",
        },
        suggestions: [
          {
            title: "Burn Severity Workflow",
            message: "Sketch a burn severity analysis workflow for a selected AOI",
          },
          {
            title: "Wildfire Integration Gap",
            message: "List the missing wildfire APIs, legends, and agent tools before production integration",
          },
        ],
      },
      landslide: {
        labels: {
          title: "Landslide Analysis Agent",
          initial: "Review landslide terrain readiness, slope layers, exposure context, and missing susceptibility workflows.",
          placeholder: "Enter landslide event or module integration question...",
        },
        suggestions: [
          {
            title: "Slope Layer",
            message: "What does the SRTM slope layer contribute to a landslide workflow?",
          },
          {
            title: "Susceptibility Inputs",
            message: "List the missing inputs for landslide susceptibility mapping in a selected AOI",
          },
          {
            title: "Landslide Integration Gap",
            message: "List the missing landslide APIs, legends, and agent tools before production integration",
          },
        ],
      },
      flood: {
        labels: {
          title: "Flood Analysis Agent",
          initial: "Ask about a flood event. Add @ only when you want to run analysis for a specific spatial scope.",
          placeholder: "Enter flood event information...",
        },
        suggestions: [
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
        ],
      },
      context: {
        labels: {
          title: "Comprehensive Context Layers",
          initial: "Load common AOI background layers such as population density, soil texture, and land cover for use across disaster workflows.",
          placeholder: "Ask about common context layers...",
        },
        suggestions: [
          {
            title: "Layer Roles",
            message: "Explain how population density, soil texture, and LCLU support disaster analysis",
          },
          {
            title: "AOI Context",
            message: "Which common context layers should I load for a selected AOI?",
          },
          {
            title: "Data Caveats",
            message: "What limitations should I remember when interpreting these context layers?",
          },
        ],
      },
      imagery: {
        labels: {
          title: "Optical and SAR Imagery",
          initial: "Load shared satellite imagery layers for a selected AOI. Optical and SAR layers stay off until you explicitly enable them.",
          placeholder: "Ask about optical or SAR imagery...",
        },
        suggestions: [
          {
            title: "Optical vs SAR",
            message: "Explain when I should use optical imagery versus SAR imagery for an AOI",
          },
          {
            title: "AOI Imagery",
            message: "Which imagery layer should I load first for a selected AOI?",
          },
          {
            title: "Imagery Caveats",
            message: "What limitations should I remember when interpreting optical and SAR imagery?",
          },
        ],
      },
      vector: {
        labels: {
          title: "Vector Layers",
          initial: "Manage uploaded, drawn, searched, or edited spatial scopes that can be reused across analysis modules.",
          placeholder: "Ask about vector scopes or AOI layers...",
        },
        suggestions: [
          {
            title: "AOI Roles",
            message: "Explain how vector scopes constrain raster rendering and analysis",
          },
          {
            title: "Layer Hygiene",
            message: "How should I organize uploaded and drawn AOI layers?",
          },
          {
            title: "Active Scope",
            message: "What is the difference between visible vector layers and the active analysis scope?",
          },
        ],
      },
    }[agentModule] || {
      labels: {
        title: "Flood Analysis Agent",
        initial: "Ask about a flood event. Add @ only when you want to run analysis for a specific spatial scope.",
        placeholder: "Enter flood event information...",
      },
      suggestions: [],
    }
  ), [agentModule]);
  const paneProfiler = useMemo(
    () => createReactProfilerHandler('AgentChatPane', () => ({ agentModule, chatMode })),
    [agentModule, chatMode]
  );
  const copilotChatProfiler = useMemo(
    () => createReactProfilerHandler('CopilotChat', () => ({ agentModule, chatMode })),
    [agentModule, chatMode]
  );

  useRenderDiagnostics('AgentChatPane', () => ({
    agentModule,
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
              key={agentModule}
              instructions={{
                wildfire: WILDFIRE_MENTION_INSTRUCTIONS,
                landslide: LANDSLIDE_MENTION_INSTRUCTIONS,
                context: CONTEXT_MENTION_INSTRUCTIONS,
                imagery: IMAGERY_MENTION_INSTRUCTIONS,
                vector: VECTOR_MENTION_INSTRUCTIONS,
                flood: AGENT_MENTION_INSTRUCTIONS,
              }[agentModule] || AGENT_MENTION_INSTRUCTIONS}
              labels={chatCopy.labels}
              suggestions={chatCopy.suggestions}
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
                  agentModule,
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
