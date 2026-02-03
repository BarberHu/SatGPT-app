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
        <i
          id="result-toggle"
          className={`fa ${isResultVisible ? 'fa-angle-down' : 'fa-angle-up'}`}
          aria-hidden="true"
          onClick={handleToggle}
        ></i>
      </div>
      
      {isResultVisible && (
        <div className="containerResult" style={{ opacity: 1 }}>
          <div className="text" id="myTextarea">
            {resultText}
          </div>
          <div className="icon-button" onClick={handleRefresh}>
            <i className="fa fa-refresh" style={{ fontSize: '32px', color: 'white' }}></i>
          </div>
        </div>
      )}
    </div>
  );
}

export default ResultBox;
