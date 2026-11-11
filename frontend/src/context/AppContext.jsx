import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  buildBusinessLayerRecordFromAoi,
  getStoredAgentSessionId,
  isBusinessLayerAoiSource,
} from '../utils/businessLayerStore';
import businessLayerRepository from '../repositories/businessLayerRepository';
import useBusinessLayerPersistence from '../hooks/useBusinessLayerPersistence';
import useWarningState from '../hooks/useWarningState';

const AppContext = createContext();

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

const activateBusinessLayer = (records = [], activeId = null) =>
  records.map((record) => ({
    ...record,
    is_active: Boolean(activeId && record.id === activeId),
    updated_at: new Date().toISOString(),
  }));

export const AppProvider = ({ children }) => {
  // UI State

  const [isLoading, setIsLoading] = useState(false);
  const { warning, setWarning, setOwnedWarning, clearOwnedWarning } = useWarningState();

  // Map State
  const [mapInstance, setMapInstance] = useState(null);
  const [selectedGridCords, setSelectedGridCords] = useState(null);
  const [selectedAOI, setSelectedAOI] = useState(null);
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

  // Retain the existing namespace so saved AOI records remain readable.
  const [agentSessionId] = useState(() => getStoredAgentSessionId());
  const [businessLayers, setBusinessLayers] = useState([]);
  const [businessLayersReady, setBusinessLayersReady] = useState(false);

  const selectedAOIRef = useRef(null);

  const setBusinessLayerActive = useCallback((activeLayerId) => {
    setBusinessLayers((previous) => {
      if (!previous.length) {
        return previous;
      }
      return activateBusinessLayer(previous, activeLayerId).map((record) => (
        activeLayerId && record.id === activeLayerId
          ? { ...record, is_visible: true }
          : record
      ));
    });
  }, []);

  const upsertBusinessLayerRecord = useCallback((record, { markActive = true } = {}) => {
    if (!record?.id) {
      return null;
    }

    let nextRecord = null;
    setBusinessLayers((previous) => {
      const now = new Date().toISOString();
      const existing = previous.find((item) => item.id === record.id) || null;
      nextRecord = {
        ...existing,
        ...record,
        created_at: record.created_at || existing?.created_at || now,
        updated_at: record.updated_at || now,
        is_active: markActive ? true : Boolean(record.is_active ?? existing?.is_active),
      };

      const existingIndex = previous.findIndex((item) => item.id === record.id);
      const merged = existingIndex >= 0
        ? previous.map((item, index) => (index === existingIndex ? nextRecord : item))
        : [...previous, nextRecord];

      return markActive ? activateBusinessLayer(merged, nextRecord.id) : merged;
    });

    return nextRecord || record;
  }, []);

  const registerBusinessLayerFromAoi = useCallback((aoi, options = {}) => {
    const nextRecord = buildBusinessLayerRecordFromAoi(aoi, options);
    if (!nextRecord) {
      return null;
    }

    upsertBusinessLayerRecord(nextRecord, { markActive: options.markActive !== false });
    return nextRecord;
  }, [upsertBusinessLayerRecord]);

  useEffect(() => {
    selectedAOIRef.current = selectedAOI;
  }, [selectedAOI]);

  const resetAskSession = useCallback(({ preserveResult = false } = {}) => {
    if (!preserveResult) {
      setResultText('');
    }
    setIsResultVisible(true);
    setWarning('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBusinessLayersReady(false);

    businessLayerRepository.load(agentSessionId)
      .then((records) => {
        if (cancelled) {
          return;
        }
        const supportedRecords = (records || []).filter((record) => isBusinessLayerAoiSource(record?.source));
        const currentSelectedAoi = selectedAOIRef.current;
        const fallbackSelectedAoi = (!supportedRecords.length && currentSelectedAoi?.id && isBusinessLayerAoiSource(currentSelectedAoi?.source))
          ? [buildBusinessLayerRecordFromAoi(currentSelectedAoi, {
              id: currentSelectedAoi.id,
              label: currentSelectedAoi.label,
              source: currentSelectedAoi.source,
              origin: currentSelectedAoi.origin || (currentSelectedAoi.source === 'draw' ? 'draw' : 'upload'),
              is_active: true,
            })].filter(Boolean)
          : [];
        setBusinessLayers(supportedRecords.length ? supportedRecords : fallbackSelectedAoi);
        setBusinessLayersReady(true);
      })
      .catch((error) => {
        console.error('Failed to load business layers from IndexedDB:', error);
        if (cancelled) {
          return;
        }
        // Keep the current in-memory records and block persistence. Treating a
        // read failure as an empty store would overwrite recoverable user data.
        setBusinessLayersReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentSessionId]);

  const handleBusinessLayerPersistenceError = useCallback((error) => {
    console.error('Failed to persist business layers:', error);
  }, []);

  useBusinessLayerPersistence({
    namespace: agentSessionId,
    records: businessLayers,
    ready: businessLayersReady,
    onError: handleBusinessLayerPersistenceError,
  });

  useEffect(() => {
    if (!selectedAOI?.id || !isBusinessLayerAoiSource(selectedAOI?.source)) {
      return;
    }

    const existingLayer = businessLayers.find((record) => record.id === selectedAOI.id);
    const nextRecord = buildBusinessLayerRecordFromAoi(selectedAOI, {
      id: selectedAOI.id,
      label: selectedAOI.label,
      source: selectedAOI.source,
      origin: selectedAOI.origin || (selectedAOI.source === 'draw' ? 'draw' : 'upload'),
      is_active: true,
      created_at: existingLayer?.created_at || selectedAOI.created_at,
    });

    if (!nextRecord) {
      return;
    }

    const shouldSkipUpdate =
      existingLayer
      && existingLayer.is_active
      && JSON.stringify(existingLayer.bounds || null) === JSON.stringify(nextRecord.bounds || null)
      && JSON.stringify(existingLayer.geojson || null) === JSON.stringify(nextRecord.geojson || null)
      && existingLayer.label === nextRecord.label
      && existingLayer.source === nextRecord.source;

    if (shouldSkipUpdate) {
      return;
    }

    setBusinessLayers((previous) => {
      const existingIndex = previous.findIndex((item) => item.id === nextRecord.id);
      const merged = existingIndex >= 0
        ? previous.map((item, index) => (index === existingIndex ? {
          ...item,
          ...nextRecord,
          created_at: item.created_at || nextRecord.created_at,
        } : item))
        : [...previous, nextRecord];

      return activateBusinessLayer(merged, nextRecord.id);
    });
  }, [businessLayers, selectedAOI]);

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

  const startAoiEdit = useCallback(() => {
    const editableAoi = selectedAOI;

    if (!editableAoi) {
      setWarning('Please select, upload, or resolve a spatial scope before editing.');
      return false;
    }

    setDraftAOI(JSON.parse(JSON.stringify(editableAoi)));
    setAoiEditorMode('edit');
    setWarning('');
    return true;
  }, [selectedAOI]);

  const applyDraftAoi = useCallback(() => {
    if (!draftAOI?.geojson) {
      setWarning('Please draw or edit a valid spatial scope before applying.');
      return false;
    }

    const nextAoi = JSON.parse(JSON.stringify(draftAOI));
    if (!isBusinessLayerAoiSource(nextAoi.source)) {
      nextAoi.source = aoiEditorMode === 'edit' ? 'edited' : 'draw';
      nextAoi.origin = 'draw';
      if (nextAoi.geojson?.properties) {
        nextAoi.geojson.properties.source = nextAoi.source;
      }
    }
    resetAskSession();
    setSelectedGridCords(null);
    setSelectedAOI(nextAoi);
    registerBusinessLayerFromAoi(nextAoi, {
      id: nextAoi.id,
      label: nextAoi.label,
      source: nextAoi.source,
      origin: nextAoi.source === 'draw' || nextAoi.source === 'edited' ? 'draw' : 'upload',
      markActive: true,
    });
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setWarning('');
    return nextAoi;
  }, [aoiEditorMode, draftAOI, registerBusinessLayerFromAoi, resetAskSession]);

  const clearAoiState = useCallback(() => {
    resetAskSession();
    setDraftAOI(null);
    setAoiEditorMode('idle');
    setSelectedGridCords(null);
    setSelectedAOI(null);
    setBusinessLayerActive(null);
    setWarning('');
    setAoiClearVersion((value) => value + 1);
  }, [resetAskSession, setBusinessLayerActive]);

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
    agentSessionId,
    businessLayers,
    businessLayersReady,
    setBusinessLayers,
    setBusinessLayerActive,
    upsertBusinessLayerRecord,
    registerBusinessLayerFromAoi,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export default AppContext;
