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
    setIsResultVisible,
    setIsLoading,
    setWarning,
    selectedAOI,
    setSelectedAOI,
    setSelectedGridCords,
    dataType,
    yearControl,
    updateLayerData,
    setGeeCodeUrl,
    setActiveModal,
    setGridClickEnabled,
    countries,
    mapInstance,
  } = useAppContext();

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStage, setSubmissionStage] = useState(null);
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
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;

    // The prompt auto-focuses OK; consume Enter so its default action cannot
    // immediately activate that newly focused button and dismiss the prompt.
    e.preventDefault();
    handleSubmit();
  };

  const handleSubmit = async () => {
    if (!chatInput.trim()) {
      setError('* Please Enter the Valid Prompt to Proceed');
      return;
    }

    setIsLoading(true);
    setIsSubmitting(true);
    setSubmissionStage('answer');
    setError('');
    requestControllerRef.current?.abort();
    const requestController = new AbortController();
    requestControllerRef.current = requestController;

    try {
      const gptResult = await sendChatMessage(chatInput, { signal: requestController.signal });
      const parsedResponse = typeof gptResult.message === 'string'
        ? JSON.parse(gptResult.message)
        : gptResult.message;
      const responses = parsedResponse?.response;
      if (!Array.isArray(responses) || !responses.length) {
        throw new Error('The Ask response did not contain an event.');
      }
      const responseData = responses[0];

      setGptResponse(responseData);
      setIsResultVisible(true);
      setResultText(dataType === 'floodHotspot'
        ? responses.map((item) => `${item.start_date} to ${item.end_date}: ${item.Content || ''}`).join('\n\n')
        : responseData.Content || '');
      // The answer is ready; any subsequent Earth Engine request only loads map data.
      setIsLoading(false);
      setSubmissionStage('map');

      if (responseData.CountryCode && countries[responseData.CountryCode]) {
        const countryData = countries[responseData.CountryCode];
        if (mapInstance) {
          mapInstance.fitBounds([
            [countryData[1][0], countryData[1][1]],
            [countryData[1][2], countryData[1][3]],
          ]);
        }
      }

      setChatInput('');
      // A prior fishnet cell belongs to the previous question. The original
      // workflow asks for a fresh cell after resolving each new event.
      if (selectedAOI?.source === 'fishnet') {
        setSelectedAOI(null);
        setSelectedGridCords(null);
      }
      if (!selectedAOI || selectedAOI.source === 'fishnet') {
        setGridClickEnabled(true);
        setActiveModal('prompt');
        return;
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
    } catch (err) {
      if (err?.isCanceled) {
        return;
      }
      console.error('Error:', err);
      setError(err?.message || 'The Ask request failed. Please try again.');
    } finally {
      if (requestControllerRef.current === requestController) {
        requestControllerRef.current = null;
        setIsLoading(false);
        setIsSubmitting(false);
        setSubmissionStage(null);
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
        {submissionStage && <p className="ask-status" role="status">
          {submissionStage === 'answer' ? '正在生成回答…' : '回答已显示，地图图层加载中…'}
        </p>}
      </div>

    </div>
  );
}

export default ChatBox;
