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
import "@copilotkit/react-ui/styles.css";

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

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(true);

  const suggestions = dataType === 'floodHotspot' ? SUGGESTIONS_HOTSPOT : SUGGESTIONS;

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
    setTimeout(() => setShowSuggestions(false), 200);
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

  // Agent mode - show CopilotKit chat (Gemini-style layout)
  if (chatMode === 'agent') {
    return (
      <div className="chat-box chat-box-gemini">
        {/* Collapse/Expand handle at top center */}
        <div 
          className="expand-handle"
          onClick={() => setAgentExpanded(!agentExpanded)}
          title={agentExpanded ? 'Collapse' : 'Expand'}
        >
          <div className="handle-bar"></div>
          <i className={`fa fa-chevron-${agentExpanded ? 'down' : 'up'}`}></i>
        </div>

        {/* Agent chat interface - expandable */}
        {agentExpanded && (
          <div className="chat-main-area">
            <CopilotChat
              labels={{
                title: "Flood Analysis Agent",
                initial: "Hello! I'm the flood event analysis assistant. Which flood event would you like to analyze?",
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
              onError={(error) => {
                if (error?.message?.includes('aborted') || error?.message?.includes('Aborted')) {
                  console.log('ℹ️ Chat operation cancelled');
                  return;
                }
                console.error('Chat error:', error);
              }}
            />
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="chat-bottom-toolbar">
          <div className="toolbar-left">
            <button className="toolbar-icon-btn" title="Download report">
              <i className="fa fa-arrow-down"></i>
            </button>
          </div>
          <div className="toolbar-right">
            <div className="mode-dropdown" onClick={() => handleModeToggle('ask')}>
              <span className="mode-label">Agent</span>
              <i className="fa fa-chevron-down"></i>
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
          .copilot-chat-full {
            height: 100%;
            min-height: 180px;
            max-height: 480px;
            background: #fafafa;
          }
          .expand-handle {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 6px 0;
            cursor: pointer;
            background: #f8f8f8;
            transition: background 0.2s;
            gap: 2px;
          }
          .expand-handle:hover {
            background: #f0f0f0;
          }
          .handle-bar {
            width: 32px;
            height: 4px;
            background: #d0d0d0;
            border-radius: 2px;
            transition: background 0.2s;
          }
          .expand-handle:hover .handle-bar {
            background: #bbb;
          }
          .expand-handle i {
            color: #999;
            font-size: 10px;
            line-height: 1;
          }
          .chat-bottom-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 8px;
            margin: 0 8px 6px 8px;
            background: #f5f5f5;
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
          .mode-dropdown {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            background: #e8e8e8;
            border-radius: 16px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .mode-dropdown:hover {
            background: #ddd;
          }
          .mode-label {
            color: #333;
            font-size: 12px;
            font-weight: 500;
          }
          .mode-dropdown i {
            color: #666;
            font-size: 9px;
          }
        `}</style>
      </div>
    );
  }

  // Ask mode (Gemini-style layout)
  return (
    <div className="chat-box chat-box-gemini">
      {/* Main input area */}
      <div className="chat-main-area ask-area">
        {showSuggestions && (
          <div id="suggestionsBox">
            <h5>Try any of these...</h5>
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                className="chat-message"
                onClick={() => handleFillSuggestion(suggestion)}
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

      {/* Bottom toolbar */}
      <div className="chat-bottom-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-icon-btn" title="Download code">
            <i className="fa fa-arrow-down"></i>
          </button>
        </div>
        <div className="toolbar-right">
          <div className="mode-dropdown" onClick={() => handleModeToggle('agent')}>
            <span className="mode-label">Ask</span>
            <i className="fa fa-chevron-down"></i>
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
          background: #f5f5f5;
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
        .mode-dropdown {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          background: #e8e8e8;
          border-radius: 16px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .mode-dropdown:hover {
          background: #ddd;
        }
        .mode-label {
          color: #333;
          font-size: 12px;
          font-weight: 500;
        }
        .mode-dropdown i {
          color: #666;
          font-size: 9px;
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
