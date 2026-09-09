/**
 * ChatBox Component
 * Handles the Ask workflow. Agent chat is rendered by AgentWorkspaceSidebar.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { sendChatMessage, getHistoricalMap, getFloodHotspotMap } from '../services/api';
import { createCodeSnippet } from '../export/geeCodeGenerator';
import { buildAskMapRequestParams } from '../utils/aoi';

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
    selectedAOI,
    dataType,
    yearControl,
    updateLayerData,
    setGeeCodeUrl,
    setActiveModal,
    countries,
    mapInstance,
  } = useAppContext();

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const requestControllerRef = useRef(null);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  const suggestions =
    dataType === 'floodHotspot'
      ? SUGGESTIONS_HOTSPOT
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
    if (!chatInput.trim()) {
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
    requestControllerRef.current?.abort();
    const requestController = new AbortController();
    requestControllerRef.current = requestController;

    try {
      const gptResult = await sendChatMessage(chatInput, { signal: requestController.signal });
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
        return;
      }

      let mapData;
      if (dataType === 'floodHotspot') {
        params.year_from = 2000;
        params.year_count = yearControl;
        mapData = await getFloodHotspotMap(params, { signal: requestController.signal });
      } else {
        mapData = await getHistoricalMap(params, { signal: requestController.signal });
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
      if (err?.isCanceled) {
        return;
      }
      console.error('Error:', err);
      setError('An error occurred. Please try again.');
      setActiveModal('error');
    } finally {
      if (requestControllerRef.current === requestController) {
        requestControllerRef.current = null;
        setIsLoading(false);
        setIsSubmitting(false);
      }
    }
  };

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
