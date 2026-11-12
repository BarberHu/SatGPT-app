import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { aoiSnapshot, clone, readBasicSelection, writeBasicSelection } from '../aoi/snapshot.js';
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

  const [isLoading, setIsLoading] = useState(false);
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
  const selectionRef = useRef(selectedAOI), outlineRef = useRef(aoiOutlineVisible);
  const persistSelection = useCallback((aoi, visible) => {
    try { writeBasicSelection(window.localStorage, aoi, visible); setAoiStorageError(''); }
    catch { setAoiStorageError('Selection is available now but could not be saved locally.'); }
  }, []);
  const setSelectedAOI = useCallback(value => {
    const next = aoiSnapshot(typeof value === 'function' ? value(selectionRef.current) : value);
    selectionRef.current = next; outlineRef.current = true;
    setSelected(next); setOutline(true); persistSelection(next, true);
  }, [persistSelection]);
  const toggleAoiOutline = useCallback(() => {
    outlineRef.current = !outlineRef.current; setOutline(outlineRef.current);
    persistSelection(selectionRef.current, outlineRef.current);
  }, [persistSelection]);
  useEffect(() => {
    if (initialSelection.readable) persistSelection(initialSelection.aoi, initialSelection.outlineVisible);
  }, [initialSelection, persistSelection]);
  const [draftAOI, setDraftAOI] = useState(null);
  const [aoiEditorMode, setAoiEditorMode] = useState('idle');
  const [aoiClearVersion, setAoiClearVersion] = useState(0);
  const [countries, setCountries] = useState({});
  const [gridClickEnabled, setGridClickEnabled] = useState(true);

  // Layer State

  const [is3DEnabled, setIs3DEnabled] = useState(false);
  const [isBuildingsEnabled, setIsBuildingsEnabled] = useState(false);

  // Chat/GPT State
  const [chatInput, setChatInput] = useState('');

  const [resultText, setResultText] = useState('');
  const [isResultVisible, setIsResultVisible] = useState(true);

  const resetAskSession = useCallback(({ preserveResult = false } = {}) => {
    if (!preserveResult) {
      setResultText('');
    }
    setIsResultVisible(true);
    setWarning('');
  }, []);

  const cancelDraftAoi = useCallback(() => {
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
  }, []);

  const startAoiDraw = useCallback(() => {
    setDraftAOI(null);
    setAoiEditorMode('draw');
    setWarning('');
  }, []);

  const startAoiEdit = useCallback((input = selectedAOI) => {
    const editableAoi = input;

    if (!editableAoi) {
      setWarning('Please select, upload, or resolve a spatial scope before editing.');
      return false;
    }

    setDraftAOI({ ...aoiSnapshot(editableAoi), aoi_ref: null, edit_ref: clone(editableAoi.edit_ref || editableAoi.aoi_ref) });
    setAoiEditorMode('edit');
    setWarning('');
    return true;
  }, [selectedAOI]);

  const applyDraftAoi = useCallback(() => {
    if (!draftAOI?.geojson) {
      setWarning('Please draw or edit a valid spatial scope before applying.');
      return false;
    }

    const nextAoi = aoiSnapshot(draftAOI);
    setSelectedGridCords(null);
    setSelectedAOI(nextAoi);
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
    return nextAoi;
  }, [draftAOI, setSelectedAOI]);

  const clearAoiState = useCallback(() => {
    resetAskSession();
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setSelectedGridCords(null);
    setSelectedAOI(null);
    setWarning('');
    setAoiClearVersion((value) => value + 1);
  }, [resetAskSession, setSelectedAOI]);

  const isAoiEditing = aoiEditorMode !== 'idle';

  const value = {
    isLoading,
    setIsLoading,
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
    draftAOI,
    setDraftAOI,
    aoiEditorMode,
    setAoiEditorMode,
    aoiClearVersion,
    isAoiEditing,
    startAoiDraw,
    startAoiEdit,
    applyDraftAoi,
    cancelDraftAoi,
    clearAoiState,
    countries,
    setCountries,
    gridClickEnabled,
    setGridClickEnabled,
    is3DEnabled,
    setIs3DEnabled,
    isBuildingsEnabled,
    setIsBuildingsEnabled,
    chatInput,
    setChatInput,
    resultText,
    setResultText,
    isResultVisible,
    setIsResultVisible,
    resetAskSession,
    aoiOutlineVisible,
    toggleAoiOutline,
    aoiStorageError,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
