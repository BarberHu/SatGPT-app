/**
 * ChatBox Component
 * Supports two modes: Ask (traditional Flask API) and Agent (CopilotKit)
 * Left side: vertical mode toggle button
 * Right side: chat input or agent chat interface
 */
import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { sendChatMessage, getHistoricalMap, getFloodHotspotMap, createCodeSnippet } from '../services/api';
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotContext } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";

const SUGGESTIONS = [
  { title: '2010 Bangkok Flood', message: 'Tell me about the 2010 Bangkok floods' },
  { title: '2020 North India Flood', message: 'How big was the flood in North India in 2020?' },
  { title: '2007 Jakarta Flood', message: 'How much area was impacted by the 2007 Jakarta floods?' },
];

const SUGGESTIONS_HOTSPOT = [
  { title: '2010–2020 Bangkok Floods', message: 'Tell me about the 2010 to 2020 Bangkok floods' },
  { title: '2015–2021 North India Floods', message: 'Provide information regarding floods occurring in North India between 2015 and 2021' },
  { title: '2007–2020 Jakarta Floods', message: 'Inform me about the floods in Jakarta spanning from 2007 to 2020' },
];

function ChatBox() {
  const {
    chatInput,
    setChatInput,
    setGptResponse,
    setResultText,
    setIsLoading,
    setWarning,
    selectedGridCords,
    dataType,
    yearControl,
    updateLayerData,
    setGeeCodeUrl,
    setActiveModal,
    countries,
    mapInstance,
    chatMode,
    setChatMode,
    appMode,
    setAppMode,
  } = useAppContext();

  const { setThreadId } = useCopilotContext();

  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [askHistory, setAskHistory] = useState([]);

  // Start a new conversation by generating a fresh thread_id
  const handleNewChat = () => {
    const newId = crypto.randomUUID();
    setThreadId(newId);
  };

  const suggestions = dataType === 'floodHotspot' ? SUGGESTIONS_HOTSPOT : SUGGESTIONS;

  const handleInputChange = (e) => {
    setChatInput(e.target.value);
    setError('');
  };

  const handleFillSuggestion = (text) => {
    setChatInput(text);
    setError('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  // Handle Ask mode submission (original logic)
  const handleSubmit = async () => {
    if (!chatInput.trim()) {
      setError('* Please Enter the Valid Prompt to Proceed');
      return;
    }

    if (!selectedGridCords) {
      setActiveModal('prompt');
      return;
    }

    // Append user message to local history
    setAskHistory(prev => [...prev, { role: 'user', text: chatInput.trim() }]);

    setIsLoading(true);
    setIsSubmitting(true);
    setError('');

    try {
      // Call ChatGPT API
      const gptResult = await sendChatMessage(chatInput);
      const parsedResponse = JSON.parse(gptResult.message);
      const responseData = parsedResponse.response[0];

      setGptResponse(responseData);
      setResultText(responseData.Content || '');

      // Append assistant reply to local history
      setAskHistory(prev => [...prev, { role: 'assistant', text: responseData.Content || 'Analysis complete.' }]);

      // Zoom to country if available
      if (responseData.CountryCode && countries[responseData.CountryCode]) {
        const countryData = countries[responseData.CountryCode];
        if (mapInstance) {
          mapInstance.fitBounds([
            [countryData[1][0], countryData[1][1]],
            [countryData[1][2], countryData[1][3]],
          ]);
        }
      }

      // Prepare params for map API
      const params = {
        AoI_cords: JSON.stringify(selectedGridCords),
        time_start: responseData.start_date,
        time_end: responseData.end_date,
      };

      // Validate dates
      if (params.time_start > params.time_end) {
        setWarning('Warning! Start date should be less than end date!');
        setIsLoading(false);
        setIsSubmitting(false);
        return;
      }

      // Call appropriate map API based on data type
      let mapData;
      if (dataType === 'floodHotspot') {
        params.year_from = 2000;
        params.year_count = yearControl;
        mapData = await getFloodHotspotMap(params);
      } else {
        mapData = await getHistoricalMap(params);
      }

      // Update layer data
      updateLayerData(mapData);

      // Generate GEE code download
      const codeSnippet = createCodeSnippet(params, dataType === 'floodHotspot' ? 'flood_hotspot' : 'historical');
      const blob = new Blob([codeSnippet], { type: 'text/javascript' });
      setGeeCodeUrl(URL.createObjectURL(blob));
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

  // Toggle mode handler - syncs chatMode and appMode
  const handleModeToggle = (mode) => {
    setChatMode(mode);
    setAppMode(mode);
    setChatInput('');
    setError('');
  };

  // Unified render for both modes
  const isAgent = chatMode === 'agent';

  return (
    <>
      {/* ====== Floating trigger button (bottom-center) ====== */}
      {!popupOpen && (
        <button className="chat-popup-trigger" onClick={() => setPopupOpen(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      )}

      {/* ====== Popup panel ====== */}
      {popupOpen && (
        <div className="chat-popup-overlay" onClick={() => setPopupOpen(false)}>
          <div className="chat-popup-panel" onClick={(e) => e.stopPropagation()}>

            {/* Main content area */}
            {isAgent ? (
              <div className="chat-main-area">
                <CopilotChat
                  labels={{
                    title: "Flood Analysis Agent",
                    initial: "",
                    placeholder: "Enter flood event information...",
                  }}
                  suggestions={[
                    { title: "2024 Chiang Mai Flood", message: "Please analyze the 2024 Chiang Mai flood event in Thailand" },
                    { title: "2021 Zhengzhou Flood", message: "Please analyze the July 2021 Zhengzhou extreme rainfall event" },
                    { title: "2020 Jakarta Flood", message: "Please analyze the January 2020 Jakarta flood event" },
                  ]}
                  className="copilot-chat-full"
                  onError={(error) => {
                    if (error?.message?.includes('aborted') || error?.message?.includes('Aborted')) {
                      console.log('ℹ️ Chat operation cancelled');
                      return;
                    }
                    console.error('Chat error:', error);
                  }}
                />
              </div>
            ) : (
              <div className="chat-main-area ask-area">
                {/* Messages area */}
                <div className="ask-messages-area">
                  {askHistory.length === 0 && !chatInput.trim() && (
                    <div className="ask-suggestions-footer">
                      <div className="ask-suggestions">
                        {suggestions.map((s, i) => (
                          <button
                            key={i}
                            className="ask-suggestion-chip"
                            onClick={() => handleFillSuggestion(s.message)}
                          >
                            {s.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {askHistory.map((msg, i) => (
                    <div key={i} className={`ask-msg ${msg.role}`}>
                      <div className="ask-msg-bubble">{msg.text}</div>
                    </div>
                  ))}
                </div>
                {/* Input area */}
                <div className="ask-input-container">
                  <div className="ask-input-box" onClick={(e) => e.currentTarget.querySelector('textarea')?.focus()}>
                    <textarea
                      className="ask-input-textarea"
                      placeholder="Enter flood event information..."
                      value={chatInput}
                      onChange={handleInputChange}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      disabled={isSubmitting}
                      rows={1}
                    />
                    <div className="ask-send-btn-row">
                      <button
                        className="ask-send-btn"
                        onClick={handleSubmit}
                        disabled={isSubmitting || !chatInput.trim()}
                      >
                        {isSubmitting ? (
                          <i className="fa fa-spinner fa-spin"></i>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                {error && <p className="error">{error}</p>}
              </div>
            )}

            {/* Inline toolbar */}
            <div className="inline-toolbar">
              <div className="inline-toolbar-left">
                <button
                  className={`mode-btn ${!isAgent ? 'active' : ''}`}
                  onClick={() => handleModeToggle('ask')}
                >
                  <i className="fa fa-search"></i>
                  <span>Ask</span>
                </button>
                <button
                  className={`mode-btn agent ${isAgent ? 'active' : ''}`}
                  onClick={() => handleModeToggle('agent')}
                >
                  <i className="fa fa-bolt"></i>
                  <span>Agent</span>
                </button>
              </div>
              <div className="inline-toolbar-right">
                {isAgent && (
                  <button className="new-chat-btn" title="New conversation" onClick={handleNewChat}>
                    <span>New Chat</span>
                    <i className="fa fa-plus"></i>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx="true">{`
        /* ====== Floating trigger button ====== */
        .chat-popup-trigger {
          position: fixed;
          bottom: 28px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 1000;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          border: none;
          background: #3b82f6;
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 16px rgba(59,130,246,0.35);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .chat-popup-trigger:hover {
          transform: translateX(-50%) scale(1.08);
          box-shadow: 0 6px 24px rgba(59,130,246,0.45);
        }

        /* ====== Overlay ====== */
        .chat-popup-overlay {
          position: fixed;
          inset: 0;
          z-index: 1001;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          padding-bottom: 24px;
          background: rgba(0,0,0,0.15);
          animation: popupFadeIn 0.2s ease;
        }
        @keyframes popupFadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

        /* ====== Popup panel ====== */
        .chat-popup-panel {
          position: relative;
          display: flex;
          flex-direction: column;
          width: 40%;
          max-width: 95vw;
          min-width: 400px;
          max-height: 70vh;
          background: #ffffff;
          border-radius: 20px;
          border: 1px solid #e0e0e0;
          box-shadow: 0 8px 40px rgba(0,0,0,0.18);
          overflow: hidden;
          animation: popupSlideUp 0.25s ease;
        }
        @keyframes popupSlideUp {
          from { transform: translateY(30px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }

        /* ====== Close button ====== */
        .chat-popup-close {
          position: absolute;
          top: 10px;
          right: 12px;
          z-index: 10;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: none;
          background: rgba(0,0,0,0.06);
          color: #666;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          transition: background 0.2s, color 0.2s;
        }
        .chat-popup-close:hover {
          background: rgba(0,0,0,0.12);
          color: #333;
        }

        /* ---- Main content area ---- */
        .chat-main-area {
          flex: 1 1 auto;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .chat-main-area.ask-area {
          display: flex;
          flex-direction: column;
          background: var(--copilot-kit-background-color, #fff);
        }

        /* ---- CopilotChat (Agent mode) ---- 
           copilot-chat-full is ON the same div as copilotKitChat (compound selector). 
           The div needs a height constraint for internal scrolling to work. */
        .copilotKitChat.copilot-chat-full {
          min-height: 0 !important;
          max-height: 100% !important;
          height: 100% !important;
          background: #fff;
          flex: 1 !important;
          display: flex !important;
          flex-direction: column !important;
          overflow: hidden !important;
        }
        /* Hide CopilotKit default header */
        .copilot-chat-full .copilotKitHeader {
          display: none !important;
        }
        /* Messages area: scrollable, flex-grows to fill available space */
        .copilot-chat-full .copilotKitMessages {
          flex: 1 1 0% !important;
          min-height: 0 !important;
          overflow-y: auto !important;
        }
        /* When empty (no messages), don't take up space */
        .copilot-chat-full .copilotKitMessages:not(:has(.copilotKitMessage)) {
          flex: 0 0 auto !important;
        }
        /* Ensure input container is always visible */
        .copilot-chat-full .copilotKitInputContainer {
          display: flex !important;
          flex-shrink: 0 !important;
        }
        .copilot-chat-full .copilotKitMessage {
          padding: 12px 16px;
          line-height: 1.6;
        }
        /* Input container — zero out all spacing, no radius, transparent bg */
        .copilot-chat-full .copilotKitInputContainer {
          padding-bottom: 0 !important;
          margin-bottom: 0 !important;
          border-radius: 0 !important;
          background: transparent !important;
        }
        /* Input box — visible border, flat bottom to fuse with toolbar */
        .copilot-chat-full .copilotKitInput {
          border: 1.5px solid #d0d5dd !important;
          border-bottom: none !important;
          border-radius: 20px 20px 0 0 !important;
          background-color: #fbfbfb !important;
          min-height: 60px !important;
          padding: 12px 14px !important;
        }
        /* Agent input textarea — match Ask mode font */
        .copilot-chat-full .copilotKitInput > textarea {
          font-size: 0.875rem !important;
          line-height: 1.5 !important;
        }
        /* Hide "Powered by CopilotKit" text only — do NOT hide poweredByContainer
           because CopilotKit adds that class to copilotKitInputContainer itself! */
        .copilot-chat-full .poweredBy {
          display: none !important;
        }

        /* ---- Unified suggestion chip styles (Agent mode) ---- */
        .copilot-chat-full .copilotKitMessagesFooter {
          padding: 0.5rem 24px !important;
        }
        .copilot-chat-full .copilotKitMessages footer .suggestions {
          gap: 8px !important;
        }
        .copilot-chat-full .copilotKitMessages footer .suggestions .suggestion {
          padding: 6px 12px !important;
          font-size: 0.75rem !important;
          border-radius: 15px !important;
          border: 1px solid #d0d5dd !important;
          color: rgb(28, 28, 28) !important;
          background: #fff !important;
          box-shadow: 0 1px 3px rgba(0,0,0,.04) !important;
          cursor: pointer !important;
        }
        .copilot-chat-full .copilotKitMessages footer .suggestions button:not(:disabled):hover {
          transform: scale(1.03) !important;
          border-color: #b0b5bb !important;
        }
        /* copilotKitChat wrapper — no bottom padding */
        .copilotKitChat.copilot-chat-full {
          padding-bottom: 0 !important;
          margin-bottom: 0 !important;
        }

        /* ---- Ask mode ---- */
        .ask-messages-area {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;         /* 👈 内容靠底部排列，贴近输入框 */
          min-height: 80px;
          padding: 1rem 24px;                /* 👈 消息区内边距(上下 左右) */
          background: var(--copilot-kit-background-color, #fff);
        }
        .ask-messages-area::-webkit-scrollbar { width: 6px; }
        .ask-messages-area::-webkit-scrollbar-thumb {
          background-color: #c8c8c8;
          border-radius: 10rem;
        }
        .ask-msg { margin-bottom: 0.5rem; display: flex; }
        .ask-msg.user { justify-content: flex-end; }
        .ask-msg.assistant { justify-content: flex-start; }
        .ask-msg-bubble {
          border-radius: 15px;
          padding: 8px 12px;
          font-size: 1rem;
          line-height: 1.5;
          max-width: 80%;
          overflow-wrap: break-word;
        }
        .ask-msg.user .ask-msg-bubble {
          background: rgb(28, 28, 28);
          color: #fff;
          white-space: pre-wrap;
        }
        .ask-msg.assistant .ask-msg-bubble {
          background: transparent;
          color: rgb(28, 28, 28);
          padding-left: 0;
        }
        .ask-suggestions-footer {
          display: flex;
          padding: 0;                        /* 👈 建议词区域内边距，改大=离边更远 */
          margin-bottom: -10px;                /* 👈 建议词与输入框的间距，改大=离输入框更远 */
          justify-content: flex-start;
          flex-direction: column;
        }
        .ask-suggestions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;                          /* 👈 建议词之间的间距 */
        }
        .ask-suggestion-chip {
          padding: 4px 8px;                 /* 👈 建议词内边距(上下 左右)，改大=按钮更大 */
          font-size: 0.8rem;                /* 👈 建议词字号，改大=文字更大 */
          border-radius: 100px;               /* 👈 圆角 */
          border: 1px solid #d0d5dd;
          color: rgb(28, 28, 28);
          background: #fff;
          box-shadow: 0 1px 3px rgba(0,0,0,.04);
          cursor: pointer;
          transition: transform 0.3s ease;
        }
        .ask-suggestion-chip:hover {
          transform: scale(1.03);
          border-color: #b0b5bb;
        }
        .ask-input-container {
          width: 100%;
          padding: 0;
          background: var(--copilot-kit-background-color, #fff);
        }
        .ask-input-box {
          cursor: text;
          position: relative;
          background-color: #fbfbfb;
          border-radius: 20px 20px 0 0;
          border: 1.5px solid #d0d5dd;
          border-bottom: none;
          padding: 12px 14px;
          min-height: 75px;
          margin: 0 auto;
          width: 95%;
          display: flex;
          flex-direction: column;
        }
        .ask-input-textarea {
          flex: 1;
          border: none;
          outline: none;
          background: transparent;
          font-size: 0.875rem;
          color: rgb(28, 28, 28);
          resize: none;
          line-height: 1.5;
          max-height: 120px;
          overflow-y: auto;
          font-family: inherit;
        }
        .ask-input-textarea::placeholder { color: #999; }
        .ask-send-btn-row {
          display: flex;
          justify-content: flex-end;
          margin-top: 4px;
        }
        .ask-send-btn {
          width: 24px;
          height: 24px;
          border: none;
          background: transparent;
          color: rgba(0, 0, 0, 0.25);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          flex-shrink: 0;
          transition: transform 0.2s, color 0.2s;
        }
        .ask-send-btn:not(:disabled) {
          color: rgb(28, 28, 28);
        }
        .ask-send-btn:not(:disabled):hover {
          transform: scale(1.05);
        }
        .ask-send-btn:disabled {
          cursor: default;
        }

        /* ============================================= */
        /* Inline toolbar — inside input area            */
        /* ============================================= */
        .inline-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 14px 10px;
          margin: 0 auto 0;
          width: 95%;
          background: var(--copilot-kit-input-background-color, #fbfbfb);
          border: 1.5px solid #d0d5dd;
          border-top: 1px solid #e8e8e8;
          border-radius: 0 0 20px 20px;
          margin-bottom: 12px;
          flex-shrink: 0;
        }
        .inline-toolbar-left,
        .inline-toolbar-right {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        /* ---- Mode toggle buttons (Ask / Agent) ---- */
        .mode-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 14px;
          border: 1px solid #e5e7eb;
          background: #ffffff;
          color: #6b7280;
          border-radius: 18px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          line-height: 1.4;
          white-space: nowrap;
        }
        .mode-btn i { font-size: 11px; }
        .mode-btn:hover {
          background: #f3f4f6;
          border-color: #d1d5db;
        }
        /* Ask active */
        .mode-btn.active {
          background: #eef4ff;
          color: #2563eb;
          border-color: #93bbfd;
        }
        /* Agent active – filled blue */
        .mode-btn.agent.active {
          background: #3b82f6;
          color: #ffffff;
          border-color: #3b82f6;
          box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
        }
        .mode-btn.agent.active:hover {
          background: #2563eb;
          border-color: #2563eb;
        }

        /* ---- New Chat button (right side) ---- */
        .new-chat-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 14px;
          border: 1px solid #e5e7eb;
          background: #ffffff;
          color: #6b7280;
          border-radius: 18px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .new-chat-btn i { font-size: 11px; }
        .new-chat-btn:hover {
          background: #f3f4f6;
          color: #333;
          border-color: #d1d5db;
        }

        .error {
          color: #e74c3c;
          padding: 0 16px 8px;
          margin: 0;
          font-size: 12px;
        }
      `}</style>
    </>
  );
}

export default ChatBox;
