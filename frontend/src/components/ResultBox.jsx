import React from 'react';
import { useAppContext } from '../context/AppContext';

function ResultBox() {
  const { 
    resultText, 
    isResultVisible, 
    setIsResultVisible,
    setChatInput,
    setResultText,
    setGptResponse,
  } = useAppContext();

  const handleToggle = () => {
    setIsResultVisible(!isResultVisible);
  };

  const handleRefresh = () => {
    setChatInput('');
    setResultText('');
    setGptResponse(null);
  };

  if (!resultText) return null;

  return (
    <div className="pt-3 result-box">
      <div className="result-text-box">
        <h4 style={{ margin: 0 }}>Result</h4>
        <button
          type="button"
          id="result-toggle"
          className="result-toggle-button"
          onClick={handleToggle}
          aria-expanded={isResultVisible}
          aria-controls="result-content"
          aria-label={isResultVisible ? 'Collapse result' : 'Expand result'}
        >
          <i className={`fa ${isResultVisible ? 'fa-angle-down' : 'fa-angle-up'}`} aria-hidden="true" />
        </button>
      </div>
      
      {isResultVisible && (
        <div id="result-content" className="containerResult" style={{ opacity: 1 }}>
          <div className="text" id="myTextarea">
            {resultText}
          </div>
          <button type="button" className="icon-button" onClick={handleRefresh} aria-label="Clear result">
            <i className="fa fa-refresh" style={{ fontSize: '32px', color: 'white' }} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export default ResultBox;
