import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { aoiSnapshot, readBasicSelection, writeBasicSelection } from '../aoi/snapshot.js';
import useWarningState from '../hooks/useWarningState';

const AppContext = createContext();

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

export const AppProvider = ({ children }) => {
  // UI State

  const { warning, setWarning, setOwnedWarning, clearOwnedWarning } = useWarningState();

  // Map State
  const [mapInstance, setMapInstance] = useState(null);
  const [selectedGridCords, setSelectedGridCords] = useState(null);
  const [initialSelection] = useState(() => {
    try { return { ...readBasicSelection(window.localStorage), readable: true }; }
    catch { return { aoi: null, outlineVisible: true, readable: false }; }
  });
  const [selectedAOI, setSelected] = useState(initialSelection.aoi);
  const [aoiOutlineVisible, setOutline] = useState(initialSelection.outlineVisible);
  const [aoiStorageError, setAoiStorageError] = useState(initialSelection.readable ? '' : 'The previous selection could not be read. Original data has been kept.');
  const selectionRef = useRef(selectedAOI);
  const persistSelection = useCallback((aoi, visible) => {
    try { writeBasicSelection(window.localStorage, aoi, visible); setAoiStorageError(''); }
    catch { setAoiStorageError('Selection is available now but could not be saved locally.'); }
  }, []);
  const setSelectedAOI = useCallback(value => {
    const next = aoiSnapshot(typeof value === 'function' ? value(selectionRef.current) : value);
    selectionRef.current = next;
    setSelected(next); setOutline(true); persistSelection(next, true);
  }, [persistSelection]);
  useEffect(() => {
    if (initialSelection.readable) persistSelection(initialSelection.aoi, initialSelection.outlineVisible);
  }, [initialSelection, persistSelection]);
  const [countries, setCountries] = useState({});
  const [gridClickEnabled, setGridClickEnabled] = useState(true);

  // Layer State

  const [is3DEnabled, setIs3DEnabled] = useState(false);
  const [isBuildingsEnabled, setIsBuildingsEnabled] = useState(false);

  const value = {
    warning,
    setWarning,
    setOwnedWarning,
    clearOwnedWarning,
    mapInstance,
    setMapInstance,
    selectedGridCords,
    setSelectedGridCords,
    selectedAOI,
    setSelectedAOI,
    countries,
    setCountries,
    gridClickEnabled,
    setGridClickEnabled,
    is3DEnabled,
    setIs3DEnabled,
    isBuildingsEnabled,
    setIsBuildingsEnabled,
    aoiOutlineVisible,
    aoiStorageError,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
