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

  // Agent mode - show CopilotKit chat
  if (chatMode === 'agent') {
    return (
      <div className="chat-box chat-box-with-toggle">
        {/* Left side: vertical toggle switch */}
        <div className="mode-toggle-container">
          <div className="mode-toggle-switch">
            <div 
              className={`toggle-slider ${chatMode === 'agent' ? 'agent-active' : ''}`}
            ></div>
            <button 
              className={`toggle-option ${chatMode === 'ask' ? 'active' : ''}`}
              onClick={() => handleModeToggle('ask')}
            >
              Ask
            </button>
            <button 
              className={`toggle-option ${chatMode === 'agent' ? 'active' : ''}`}
              onClick={() => handleModeToggle('agent')}
            >
              Agent
            </button>
          </div>
        </div>
        
        {/* Right side: Agent chat interface */}
        <div className="chat-content agent-mode">
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
            className="copilot-chat-inline"
            onError={(error) => {
              // Silently ignore abort errors (user cancelled)
              if (error?.message?.includes('aborted') || error?.message?.includes('Aborted')) {
                console.log('ℹ️ Chat operation cancelled');
                return;
              }
              console.error('Chat error:', error);
            }}
          />
        </div>

        <style jsx="true">{`
          .chat-box-with-toggle {
            display: flex;
            flex-direction: row;
            gap: 0;
            align-items: stretch;
          }
          .mode-toggle-container {
            display: flex;
            align-items: center;
            padding: 8px;
            background: #f5f5f5;
            border-radius: 12px 0 0 12px;
          }
          .mode-toggle-switch {
            position: relative;
            display: flex;
            flex-direction: column;
            background: #e0e0e0;
            border-radius: 20px;
            padding: 3px;
            gap: 2px;
          }
          .toggle-slider {
            position: absolute;
            width: calc(100% - 6px);
            height: calc(50% - 4px);
            background: white;
            border-radius: 16px;
            top: 3px;
            left: 3px;
            transition: top 0.25s ease;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .toggle-slider.agent-active {
            top: calc(50% + 1px);
          }
          .toggle-option {
            position: relative;
            z-index: 1;
            padding: 8px 12px;
            border: none;
            background: transparent;
            color: #888;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            border-radius: 16px;
            transition: color 0.2s;
            white-space: nowrap;
          }
          .toggle-option.active {
            color: #333;
          }
          .toggle-option:hover {
            color: #555;
          }
          .chat-content {
            flex: 1;
            min-width: 0;
          }
          .chat-content.agent-mode {
            background: #fafafa;
            border-radius: 0 12px 12px 0;
            overflow: hidden;
            border: 1px solid #e8e8e8;
            border-left: none;
          }
          .copilot-chat-inline {
            height: 100%;
            min-height: 200px;
            max-height: 300px;
          }
        `}</style>
      </div>
    );
  }

  // Ask mode
  return (
    <div className="chat-box chat-box-with-toggle">
      {/* Left side: vertical toggle switch */}
      <div className="mode-toggle-container">
        <div className="mode-toggle-switch">
          <div 
            className={`toggle-slider ${chatMode === 'agent' ? 'agent-active' : ''}`}
          ></div>
          <button 
            className={`toggle-option ${chatMode === 'ask' ? 'active' : ''}`}
            onClick={() => handleModeToggle('ask')}
          >
            Ask
          </button>
          <button 
            className={`toggle-option ${chatMode === 'agent' ? 'active' : ''}`}
            onClick={() => handleModeToggle('agent')}
          >
            Agent
          </button>
        </div>
      </div>

      {/* Right side: Ask chat interface */}
      <div className="chat-content ask-mode">
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

        <div className="chat-msg">
          <input
            type="text"
            className="chat-input"
            placeholder="Type your prompt here"
            value={chatInput}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
          />
          <button className="send-btn" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <i className="fa fa-spinner fa-spin"></i>
            ) : (
              <i className="fa fa-send"></i>
            )}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <style jsx="true">{`
        .chat-box-with-toggle {
          display: flex;
          flex-direction: row;
          gap: 0;
          align-items: stretch;
        }
        .mode-toggle-container {
          display: flex;
          align-items: center;
          padding: 8px;
          background: #f5f5f5;
          border-radius: 12px 0 0 12px;
        }
        .mode-toggle-switch {
          position: relative;
          display: flex;
          flex-direction: column;
          background: #e0e0e0;
          border-radius: 20px;
          padding: 3px;
          gap: 2px;
        }
        .toggle-slider {
          position: absolute;
          width: calc(100% - 6px);
          height: calc(50% - 4px);
          background: white;
          border-radius: 16px;
          top: 3px;
          left: 3px;
          transition: top 0.25s ease;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .toggle-slider.agent-active {
          top: calc(50% + 1px);
        }
        .toggle-option {
          position: relative;
          z-index: 1;
          padding: 8px 12px;
          border: none;
          background: transparent;
          color: #888;
          cursor: pointer;
          font-size: 11px;
          font-weight: 600;
          border-radius: 16px;
          transition: color 0.2s;
          white-space: nowrap;
        }
        .toggle-option.active {
          color: #333;
        }
        .toggle-option:hover {
          color: #555;
        }
        .chat-content {
          flex: 1;
          min-width: 0;
        }
        .chat-content.ask-mode {
          display: flex;
          flex-direction: column;
        }
      `}</style>
    </div>
  );
}

export default ChatBox;
