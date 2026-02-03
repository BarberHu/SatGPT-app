import React from 'react';
import { useAppContext } from '../context/AppContext';

function Spinner() {
  const { isLoading } = useAppContext();

  if (!isLoading) return null;

  return (
    <div id="spinner-overlay" className="overlay">
      <div className="lds-dual-ring"></div>
    </div>
  );
}

export default Spinner;
