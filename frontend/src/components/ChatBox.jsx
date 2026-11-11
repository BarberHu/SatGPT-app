import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { sendChatMessage } from '../services/api';

const SUGGESTIONS = [
  'Tell me about the 2010 Bangkok floods',
  'How big was the flood in North India in 2020?',
  'How much area was impacted by the 2007 Jakarta floods?',
];

function ChatBox() {
  const {
    chatInput,
    setChatInput,
    setResultText,
    setIsResultVisible,
    setIsLoading,
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

    // Consume Enter so the keyboard event cannot trigger another default action.
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
    setError('');
    requestControllerRef.current?.abort();
    const requestController = new AbortController();
    requestControllerRef.current = requestController;

    const viewIntent = mapInstance?.createViewLease?.() || mapInstance;
    try {
      const gptResult = await sendChatMessage(chatInput, { signal: requestController.signal });
      if (requestControllerRef.current !== requestController || requestController.signal.aborted) return;
      const parsedResponse = typeof gptResult.message === 'string'
        ? JSON.parse(gptResult.message)
        : gptResult.message;
      const responses = parsedResponse?.response;
      if (!Array.isArray(responses) || !responses.length) {
        throw new Error('The Ask response did not contain an event.');
      }
      const responseData = responses[0];

      setIsResultVisible(true);
      setResultText(responseData.Content || '');

      if (responseData.CountryCode && countries[responseData.CountryCode]) {
        const countryData = countries[responseData.CountryCode];
        if (mapInstance) {
          viewIntent.fitBounds([
            [countryData[1][0], countryData[1][1]],
            [countryData[1][2], countryData[1][3]],
          ]);
        }
      }

      setChatInput('');
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
      }
    }
  };

  return (
    <div className="chat-box chat-box-gemini">
      <div className="chat-main-area ask-area">
        {showSuggestions && (
          <div id="suggestionsBox">
            <h5>Try any of these...</h5>
            {SUGGESTIONS.map((suggestion, index) => (
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
        {isSubmitting && <p className="ask-status" role="status">
          Generating answer…
        </p>}
      </div>

    </div>
  );
}

export default ChatBox;
