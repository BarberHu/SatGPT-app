import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { getAgentRasterLayers, getHistoricalMap, getFloodHotspotMap, createCodeSnippet } from '../services/api';
import { buildAskMapRequestParams } from '../utils/aoi';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';

const FLOOD_HOTSPOT_YEAR_FROM = 1988;
const ASK_AUTOLOAD_AOI_SOURCES = new Set(['fishnet']);
const AGENT_AUTOLOAD_AOI_SOURCES = new Set(['fishnet']);

const isAskAutoloadAoi = (aoi) => ASK_AUTOLOAD_AOI_SOURCES.has(String(aoi?.source || '').toLowerCase());
const isFishnetAoi = (aoi) => String(aoi?.source || '').toLowerCase() === 'fishnet';
const isAgentAutoloadAoi = (aoi) => {
  const source = String(aoi?.source || '').toLowerCase();
  return AGENT_AUTOLOAD_AOI_SOURCES.has(source) || isBusinessLayerAoiSource(source);
};
const canAutoloadAoi = (mode, aoi) => (
  mode === 'ask'
    ? isAskAutoloadAoi(aoi)
    : mode === 'agent'
      ? isAgentAutoloadAoi(aoi)
      : false
);

export const useMapData = () => {
  const {
    selectedAOI,
    aoiClearVersion,
    dataType,
    yearControl,
    appMode,
    setIsLoading,
    setAgentRasterLoading,
    setWarning,
    updateLayerData,
    setGeeCodeUrl,
  } = useAppContext();

  // Track previous grid coords to detect changes
  const prevAoiRef = useRef(null);
  const requestIdRef = useRef(0);
  const appModeRef = useRef(appMode);
  const previousModeRef = useRef(appMode);

  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  // Fetch map data when grid is selected
  const fetchMapData = useCallback(async (aoi) => {
    const currentMode = appModeRef.current;
    if (!aoi || !canAutoloadAoi(currentMode, aoi)) return;
    const requestId = ++requestIdRef.current;

    console.log('fetchMapData called with AOI:', aoi);

    // Build parameters
    const params = buildAskMapRequestParams(aoi, {
      time_start: '2010-01-01',
      time_end: '2024-12-31',
      cloud_mask: 'true',
      climatology: 'false',
      month_from: '1',
      month_to: '12',
    });

    console.log('API params:', params);
    if (currentMode === 'ask') {
      setIsLoading(true);
    } else if (currentMode === 'agent') {
      setAgentRasterLoading(true);
    }
    setWarning('');

    try {
      let data;

      if (currentMode === 'agent') {
        data = await getAgentRasterLayers(params);
      } else if (dataType === 'historical') {
        data = await getHistoricalMap(params);
      } else {
        // Flood hotspot
        params.year_from = FLOOD_HOTSPOT_YEAR_FROM;
        params.year_count = yearControl;
        data = await getFloodHotspotMap(params);
      }

      if (requestIdRef.current !== requestId || appModeRef.current !== currentMode) {
        return;
      }

      // Update layer data in context
      updateLayerData(data);

      if (currentMode !== 'ask') {
        return;
      }

      // Create GEE code snippet and download URL
      const codeType = dataType === 'historical'
        ? 'historical'
        : 'flood_hotspot';
      const codeSnippet = createCodeSnippet(params, codeType);
      if (codeSnippet) {
        const blob = new Blob([codeSnippet], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        setGeeCodeUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return url;
        });
        console.log('GEE code URL created:', url);
      }

    } catch (error) {
      if (requestIdRef.current !== requestId || appModeRef.current !== currentMode) {
        return;
      }
      console.error('Error fetching map data:', error);
      setWarning('Error loading map data. Please try again.');
    } finally {
      if (requestIdRef.current === requestId) {
        if (currentMode === 'ask') {
          setIsLoading(false);
        } else if (currentMode === 'agent') {
          setAgentRasterLoading(false);
        }
      }
    }
  }, [dataType, yearControl, setAgentRasterLoading, setIsLoading, setWarning, updateLayerData, setGeeCodeUrl]);

  // Auto-fetch when AOI is selected or data type changes
  useEffect(() => {
    const previousMode = previousModeRef.current;
    const modeChanged = previousMode !== appMode;
    previousModeRef.current = appMode;

    if (appMode !== 'ask' && appMode !== 'agent') {
      prevAoiRef.current = null;
      requestIdRef.current += 1;
      setIsLoading(false);
      setAgentRasterLoading(false);
      return;
    }

    if (modeChanged) {
      prevAoiRef.current = null;
      requestIdRef.current += 1;
      setIsLoading(false);
      setAgentRasterLoading(false);

      if (isFishnetAoi(selectedAOI)) {
        return;
      }
    }

    if (selectedAOI && canAutoloadAoi(appMode, selectedAOI)) {
      console.log('selectedAOI changed:', selectedAOI);
      const currentAoiStr = JSON.stringify(selectedAOI);
      const prevAoiStr = JSON.stringify(prevAoiRef.current);
      
      if (modeChanged || currentAoiStr !== prevAoiStr || !prevAoiRef.current) {
        console.log('Fetching map data for new AOI...');
        prevAoiRef.current = selectedAOI;
        fetchMapData(selectedAOI);
      }
    } else {
      prevAoiRef.current = null;
      requestIdRef.current += 1;
      setIsLoading(false);
      setAgentRasterLoading(false);
    }
  }, [appMode, selectedAOI, fetchMapData, setAgentRasterLoading, setIsLoading]);

  useEffect(() => {
    requestIdRef.current += 1;
    prevAoiRef.current = null;
    setIsLoading(false);
    setAgentRasterLoading(false);
  }, [aoiClearVersion, setAgentRasterLoading, setIsLoading]);

  // Also refetch when dataType or yearControl changes (if grid is selected)
  useEffect(() => {
    if (
      selectedAOI
      && prevAoiRef.current
      && (
        (appMode === 'ask' && isAskAutoloadAoi(selectedAOI))
        || (appMode === 'agent' && isAgentAutoloadAoi(selectedAOI))
      )
    ) {
      fetchMapData(selectedAOI);
    }
  }, [appMode, dataType, yearControl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { fetchMapData };
};

export default useMapData;
