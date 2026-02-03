import React, { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { sendChatMessage, getHistoricalMap, getFloodHotspotMap, createCodeSnippet } from '../services/api';

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
  } = useAppContext();

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [error, setError] = useState('');

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

    } catch (err) {
      console.error('Error:', err);
      setError('An error occurred. Please try again.');
      setActiveModal('error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="chat-box">
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
        />
        <button onClick={handleSubmit}>
          <i className="fa fa-send"></i>
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default ChatBox;
