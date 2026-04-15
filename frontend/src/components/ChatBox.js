/**
 * ChatBox Component
 * Supports two modes: Ask (traditional Flask API) and Agent (CopilotKit)
 * Left side: vertical mode toggle button
 * Right side: chat input or agent chat interface
 */
import React, { useState } from 'react';
import {
  useAgentContext,
  useAskContext,
  useBusinessLayerContext,
  useMapContext,
  useUiContext,
} from '../context/AppContext';
import { sendChatMessage, getHistoricalMap, getFloodHotspotMap, getWaterRegimeChangeMap, createCodeSnippet } from '../services/api';
import { buildAskMapRequestParams } from '../utils/aoi';
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotContext } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { trackUxEvent } from '../utils/analytics';
import AgentChatInput from './AgentChatInput';
import AgentUserMessage from './AgentUserMessage';

const SUGGESTIONS = [
  'Tell me about the 2010 Bangkok floods',
  'How big was the flood in North India in 2020?',
  'How much area was impacted by the 2007 Jakarta floods?',
];

const SUGGESTIONS_HOTSPOT = [
  'Tell me about the 2010 to 2020 Bangkok floods',
  'Provide information regarding floods occurring in North India between 2015 and 2021',
  'Inform me about the floods in Jakarta spanning from 2007 to 2020',
];

const SUGGESTIONS_REGIME_CHANGE = [
  'Show long-term water regime changes around Tonle Sap',
  'Diagnose historical water regime transitions in the Nile Delta',
  'Map permanent and seasonal water changes for this AOI',
];

const AGENT_MENTION_INSTRUCTIONS = `
If the user's message contains a metadata block wrapped by <<SATGPT_MENTION_CONTEXT>> and <<END_SATGPT_MENTION_CONTEXT>>, parse that JSON first.
Treat it as authoritative metadata for the spatial scope the user explicitly referenced in the text.
The metadata only provides lightweight ids, labels, types, and sources. Do not treat it as raw geometry or as the full dataset payload.
For spatial execution, only trust explicit uploaded or drawn scope mentions that resolve from the synced business layer store.
If no explicit spatial mention is present, ask the user to provide one instead of silently falling back to a location-derived boundary.
When you explain your reasoning, refer to the visible @label the user typed, but do not expose the raw metadata block back to the user unless they explicitly ask for it.
`;

function ChatBox() {
  const {
    chatInput,
    setChatInput,
    setGptResponse,
    setResultText,
    dataType,
    yearControl,
    updateLayerData,
    setGeeCodeUrl,
  } = useAskContext();

  const {
    setIsLoading,
    setWarning,
    setActiveModal,
    chatMode,
    setChatMode,
    setAppMode,
  } = useUiContext();

  const {
    selectedAOI,
    countries,
    mapInstance,
  } = useMapContext();

  const { resetAgentSession } = useAgentContext();
  const { startNewAgentSession } = useBusinessLayerContext();

  const { setThreadId } = useCopilotContext();

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(false);

  const handleNewChat = () => {
    const newId = crypto.randomUUID();
    setThreadId(newId);
    startNewAgentSession({ preserveSelectedAoi: true });
    resetAgentSession({ preserveSelectedAoi: true });
    setAgentExpanded(false);
    trackUxEvent('agent_new_chat', { mode: chatMode });
  };

  const openAgentPanel = () => {
    setAgentExpanded(true);
  };

  const suggestions =
    dataType === 'floodHotspot'
      ? SUGGESTIONS_HOTSPOT
      : dataType === 'waterRegimeChange'
      ? SUGGESTIONS_REGIME_CHANGE
      : SUGGESTIONS;

  const handleInputChange = (e) => {
    setChatInput(e.target.value);
    setError('');
  };

  const handleFillSuggestion = (text) => {
    setChatInput(text);
    setShowSuggestions(false);
    setError('');
  };

  const handleFocus = () => {
    setShowSuggestions(true);
  };

  const handleBlur = () => {
    window.setTimeout(() => setShowSuggestions(false), 200);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!chatInput.trim() && dataType !== 'waterRegimeChange') {
      setError('* Please Enter the Valid Prompt to Proceed');
      return;
    }

    if (!selectedAOI) {
      setActiveModal('prompt');
      return;
    }

    setIsLoading(true);
    setIsSubmitting(true);
    setError('');

    try {
      if (dataType === 'waterRegimeChange') {
        const params = buildAskMapRequestParams(selectedAOI, {
          time_start: '1984-03-16',
          time_end: '2021-12-31',
        });

        const mapData = await getWaterRegimeChangeMap(params);
        updateLayerData(mapData);
        setGptResponse(null);
        setResultText('Water Regime Change diagnoses long-term hydrologic transition using the JRC Global Surface Water transition classes. It highlights where water has become more permanent, more seasonal, or has been lost over the long-term record.');

        const codeSnippet = createCodeSnippet(params, 'water_regime_change');
        const blob = new Blob([codeSnippet], { type: 'text/javascript' });
        const nextUrl = URL.createObjectURL(blob);
        setGeeCodeUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return nextUrl;
        });
        setChatInput('');
        return;
      }

      const gptResult = await sendChatMessage(chatInput);
      const parsedResponse = JSON.parse(gptResult.message);
      const responseData = parsedResponse.response[0];

      setGptResponse(responseData);
      setResultText(responseData.Content || '');

      if (responseData.CountryCode && countries[responseData.CountryCode]) {
        const countryData = countries[responseData.CountryCode];
        if (mapInstance) {
          mapInstance.fitBounds([
            [countryData[1][0], countryData[1][1]],
            [countryData[1][2], countryData[1][3]],
          ]);
        }
      }

      const params = buildAskMapRequestParams(selectedAOI, {
        time_start: responseData.start_date,
        time_end: responseData.end_date,
      });

      if (params.time_start > params.time_end) {
        setWarning('Warning! Start date should be less than end date!');
        setIsLoading(false);
        setIsSubmitting(false);
        return;
      }

      let mapData;
      if (dataType === 'floodHotspot') {
        params.year_from = 2000;
        params.year_count = yearControl;
        mapData = await getFloodHotspotMap(params);
      } else {
        mapData = await getHistoricalMap(params);
      }

      updateLayerData(mapData);

      const codeSnippet = createCodeSnippet(
        params,
        dataType === 'floodHotspot' ? 'flood_hotspot' : 'historical'
      );
      const blob = new Blob([codeSnippet], { type: 'text/javascript' });
      const nextUrl = URL.createObjectURL(blob);
      setGeeCodeUrl((previousUrl) => {
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl);
        }
        return nextUrl;
      });
      setChatInput('');
    } catch (err) {
      console.error('Error:', err);
      setError('An error occurred. Please try again.');
      setActiveModal('error');
    } finally {
      setIsLoading(false);
      setIsSubmitting(false);
    }
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
    setError('');
    if (mode === 'agent') {
      setAgentExpanded(false);
    }
  };

  if (chatMode === 'agent') {
    return (
      <div className="chat-box chat-box-gemini">
        {agentExpanded && (
          <div
            className="expand-handle"
            onClick={() => setAgentExpanded(false)}
            title="Collapse"
          >
            <div className="handle-pill">
              <div className="handle-bar"></div>
              <i className="fa fa-chevron-down"></i>
            </div>
          </div>
        )}

        {agentExpanded && (
          <div className="chat-main-area">
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
              className="copilot-chat-full"
              Input={AgentChatInput}
              UserMessage={AgentUserMessage}
              onError={(copilotError) => {
                if (
                  copilotError?.message?.includes('aborted') ||
                  copilotError?.message?.includes('Aborted')
                ) {
                  console.log('ℹ️ Chat operation cancelled');
                  return;
                }
                console.error('Chat error:', copilotError);
              }}
            />
          </div>
        )}

        {!agentExpanded && (
          <div className="chat-main-area agent-collapsed-area">
            <div className="agent-collapsed-shell">
              <button
                type="button"
                className="agent-collapsed-entry"
                onClick={openAgentPanel}
              >
                <span className="agent-collapsed-placeholder">
                  Enter flood event information...
                </span>
              </button>
              <button
                type="button"
                className="agent-collapsed-send"
                onClick={openAgentPanel}
                aria-label="Open agent panel"
              >
                <i className="fa fa-paper-plane"></i>
              </button>
            </div>
          </div>
        )}

        <div className="chat-bottom-toolbar">
          <div className="toolbar-left">
            <button className="toolbar-icon-btn" title="New conversation" onClick={handleNewChat}>
              <i className="fa fa-plus"></i>
            </button>
          </div>
          <div className="toolbar-right">
            <div className="mode-toggle">
              <button
                className={`mode-toggle-btn ${chatMode === 'ask' ? 'active' : ''}`}
                onClick={() => handleModeToggle('ask')}
              >
                Ask
              </button>
              <button
                className={`mode-toggle-btn ${chatMode === 'agent' ? 'active' : ''}`}
                onClick={() => handleModeToggle('agent')}
              >
                Agent
              </button>
            </div>
          </div>
        </div>

        <style jsx="true">{`
          .chat-box-gemini {
            display: flex;
            flex-direction: column;
            background: #ffffff;
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid #e0e0e0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          }
          .chat-main-area {
            flex: 1;
            min-height: 0;
            position: relative;
          }
          .chat-main-area.agent-collapsed-area {
            display: flex;
            align-items: center;
            padding: 10px 16px 2px;
          }
          .agent-collapsed-shell {
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
          }
          .agent-collapsed-entry {
            flex: 1;
            min-height: 52px;
            display: flex;
            align-items: center;
            padding: 0 18px;
            border: none;
            border-radius: 999px;
            background: transparent;
            color: inherit;
            text-align: left;
            cursor: pointer;
          }
          .agent-collapsed-placeholder {
            color: #999;
            font-size: 15px;
          }
          .agent-collapsed-send {
            width: 42px;
            height: 42px;
            border: none;
            background: #4a90d9;
            color: #ffffff;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            transition: all 0.2s ease;
          }
          .agent-collapsed-send:hover {
            background: #5a9fe9;
            transform: scale(1.04);
          }
          .copilot-chat-full {
            height: 100%;
            min-height: 180px;
            max-height: 440px;
            background: transparent;
          }
          .chat-box-gemini .copilotKitChat,
          .chat-box-gemini .copilotKitMessages {
            background: transparent;
            color: #0f172a;
          }
          .chat-box-gemini .copilotKitMessagesContainer {
            padding: 10px 16px 4px;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .chat-box-gemini .copilotKitMessagesFooter {
            width: calc(100% - 32px);
            padding: 2px 0 6px;
            margin: 0 auto;
            background: transparent;
          }
          .chat-box-gemini .copilotKitMessage {
            max-width: 94%;
            border-radius: 14px;
            padding: 8px 12px;
            margin-bottom: 6px;
            font-size: 14px;
            line-height: 1.6;
          }
          .chat-box-gemini .copilotKitMessage.copilotKitAssistantMessage {
            background: transparent;
            border: none;
            box-shadow: none;
            color: #1f2937;
            padding: 4px 0;
            margin-bottom: 4px;
          }
          .chat-box-gemini .copilotKitMessage.copilotKitAssistantMessage .copilotKitMessageControls {
            display: none !important;
          }
          .chat-box-gemini .copilotKitMessageControls.currentMessage,
          .chat-box-gemini .copilotKitMessage.copilotKitAssistantMessage:hover .copilotKitMessageControls {
            display: none !important;
            opacity: 0 !important;
          }
          .chat-box-gemini .copilotKitMessage.copilotKitUserMessage {
            background: #4a90d9;
            border: none;
            box-shadow: none;
            color: #ffffff;
          }
          .chat-box-gemini .copilotKitMessages footer h6 {
            margin: 0 0 6px;
            color: #64748b;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.02em;
            text-transform: none;
          }
          .chat-box-gemini .copilotKitMessages footer .suggestions {
            gap: 8px;
          }
          .chat-box-gemini .copilotKitMessages footer .suggestions .suggestion {
            padding: 6px 12px;
            border-radius: 999px;
            border: 1px solid #d6dbe4;
            background: #ffffff;
            color: #475569;
            box-shadow: none;
            font-size: 12px;
          }
          .chat-box-gemini .copilotKitMessages footer .suggestions button:not(:disabled):hover .suggestion,
          .chat-box-gemini .copilotKitMessages footer .suggestions .suggestion:hover {
            transform: none;
            border-color: #bfd2eb;
            background: #f7fbff;
            color: #3b6ea5;
          }
          .expand-handle {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 8px 0 2px;
            cursor: pointer;
            background: transparent;
          }
          .handle-pill {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 3px;
            padding: 3px 12px 1px;
            border-radius: 999px;
            transition: background 0.2s ease;
          }
          .expand-handle:hover .handle-pill {
            background: #f6f8fb;
          }
          .handle-bar {
            width: 34px;
            height: 4px;
            background: #cbd5e1;
            border-radius: 999px;
            transition: background 0.2s ease, transform 0.2s ease;
          }
          .expand-handle:hover .handle-bar {
            background: #94a3b8;
            transform: scaleX(1.04);
          }
          .handle-pill i {
            color: #94a3b8;
            font-size: 11px;
            line-height: 1;
          }
          .chat-bottom-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px;
            margin: 0 8px 6px 8px;
            background: transparent;
            border: none;
            border-radius: 20px;
            box-shadow: none;
          }
          .toolbar-left, .toolbar-right {
            display: flex;
            align-items: center;
            gap: 4px;
          }
          .toolbar-icon-btn {
            width: 28px;
            height: 28px;
            border: none;
            background: transparent;
            color: #666;
            cursor: pointer;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.2s;
          }
          .toolbar-icon-btn:hover {
            background: #e8e8e8;
            color: #333;
            box-shadow: none;
          }
          .mode-toggle {
            display: flex;
            align-items: center;
            background: #e8e8e8;
            border-radius: 16px;
            padding: 2px;
            gap: 0;
            border: none;
          }
          .mode-toggle-btn {
            padding: 4px 14px;
            border: none;
            background: transparent;
            color: #888;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            border-radius: 14px;
            transition: all 0.25s ease;
            line-height: 1.4;
          }
          .mode-toggle-btn:hover {
            color: #555;
          }
          .mode-toggle-btn.active {
            background: #ffffff;
            color: #333;
            box-shadow: 0 1px 3px rgba(0,0,0,0.12);
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="chat-box chat-box-gemini">
      <div className="chat-main-area ask-area">
        {showSuggestions && (
          <div id="suggestionsBox">
            <h5>Try any of these...</h5>
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                className="chat-message"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleFillSuggestion(suggestion);
                }}
              >
                {suggestion}
              </div>
            ))}
          </div>
        )}

        <div className="chat-input-wrapper">
          <input
            type="text"
            className="chat-input-gemini"
            placeholder="Type your prompt here"
            value={chatInput}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
          />
          <button className="send-btn-gemini" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <i className="fa fa-spinner fa-spin"></i>
            ) : (
              <i className="fa fa-send"></i>
            )}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <div className="chat-bottom-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-icon-btn" title="Download code">
            <i className="fa fa-arrow-down"></i>
          </button>
        </div>
        <div className="toolbar-right">
          <div className="mode-toggle">
            <button
              className={`mode-toggle-btn ${chatMode === 'ask' ? 'active' : ''}`}
              onClick={() => handleModeToggle('ask')}
            >
              Ask
            </button>
            <button
              className={`mode-toggle-btn ${chatMode === 'agent' ? 'active' : ''}`}
              onClick={() => handleModeToggle('agent')}
            >
              Agent
            </button>
          </div>
        </div>
      </div>

      <style jsx="true">{`
        .chat-box-gemini {
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid #e0e0e0;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .chat-main-area {
          flex: 1;
          min-height: 0;
        }
        .chat-main-area.ask-area {
          display: flex;
          flex-direction: column;
          padding: 0;
        }
        .chat-input-wrapper {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          gap: 12px;
        }
        .chat-input-gemini {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #333;
          font-size: 15px;
          padding: 8px 0;
        }
        .chat-input-gemini::placeholder {
          color: #999;
        }
        .send-btn-gemini {
          width: 36px;
          height: 36px;
          border: none;
          background: #4a90d9;
          color: white;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          transition: all 0.2s;
        }
        .send-btn-gemini:hover {
          background: #5a9fe9;
          transform: scale(1.05);
        }
        .send-btn-gemini:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .chat-bottom-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 4px 8px;
          margin: 0 8px 6px 8px;
          background: transparent;
          border-radius: 20px;
        }
        .toolbar-left, .toolbar-right {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .toolbar-icon-btn {
          width: 28px;
          height: 28px;
          border: none;
          background: transparent;
          color: #666;
          cursor: pointer;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          transition: all 0.2s;
        }
        .toolbar-icon-btn:hover {
          background: #e8e8e8;
          color: #333;
        }
        .mode-toggle {
          display: flex;
          align-items: center;
          background: #e8e8e8;
          border-radius: 16px;
          padding: 2px;
          gap: 0;
        }
        .mode-toggle-btn {
          padding: 4px 14px;
          border: none;
          background: transparent;
          color: #888;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border-radius: 14px;
          transition: all 0.25s ease;
          line-height: 1.4;
        }
        .mode-toggle-btn:hover {
          color: #555;
        }
        .mode-toggle-btn.active {
          background: #ffffff;
          color: #333;
          box-shadow: 0 1px 3px rgba(0,0,0,0.12);
        }
        #suggestionsBox {
          background: #fafafa;
          border-bottom: 1px solid #e8e8e8;
        }
        #suggestionsBox h5 {
          color: #666;
        }
        #suggestionsBox .chat-message {
          color: #333;
        }
        #suggestionsBox .chat-message:hover {
          background: #f0f0f0;
        }
        .error {
          color: #e74c3c;
          padding: 0 16px 8px;
          margin: 0;
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}

export default ChatBox;
