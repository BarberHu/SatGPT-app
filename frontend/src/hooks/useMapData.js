import { useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { useAskContext, useMapContext, useUiContext } from '../context/AppContext';
import { getHistoricalMap, getFloodHotspotMap, getWaterRegimeChangeMap, createCodeSnippet } from '../services/api';
import { buildAskMapRequestParams } from '../utils/aoi';

const FLOOD_HOTSPOT_YEAR_FROM = 1988;
const ASK_AUTOLOAD_AOI_SOURCES = new Set(['fishnet']);

const isAskAutoloadAoi = (aoi) => ASK_AUTOLOAD_AOI_SOURCES.has(String(aoi?.source || '').toLowerCase());
const buildAoiRequestKey = (aoi) => JSON.stringify({
  id: aoi?.id || null,
  source: aoi?.source || null,
  updated_at: aoi?.updated_at || null,
  bounds: aoi?.bounds || null,
});

export const useMapData = () => {
  const {
    selectedAOI,
    aoiClearVersion,
  } = useMapContext();

  const {
    dataType,
    yearControl,
    updateLayerData,
    setGeeCodeUrl,
  } = useAskContext();
  const { appMode, setIsLoading, setWarning } = useUiContext();

  // Track previous grid coords to detect changes
  const prevAoiKeyRef = useRef('');
  const requestIdRef = useRef(0);
  const appModeRef = useRef(appMode);
  const activeRequestControllerRef = useRef(null);

  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  // Fetch map data when grid is selected
  const fetchMapData = useCallback(async (aoi) => {
    if (!aoi || appModeRef.current !== 'ask' || !isAskAutoloadAoi(aoi)) return;
    const requestId = ++requestIdRef.current;
    activeRequestControllerRef.current?.abort();
    const controller = new AbortController();
    activeRequestControllerRef.current = controller;

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
    setIsLoading(true);
    setWarning('');

    try {
      let data;
      
      if (dataType === 'historical') {
        data = await getHistoricalMap(params, { signal: controller.signal });
      } else if (dataType === 'waterRegimeChange') {
        data = await getWaterRegimeChangeMap(params, { signal: controller.signal });
      } else {
        // Flood hotspot
        params.year_from = FLOOD_HOTSPOT_YEAR_FROM;
        params.year_count = yearControl;
        data = await getFloodHotspotMap(params, { signal: controller.signal });
      }

      if (requestIdRef.current !== requestId || appModeRef.current !== 'ask') {
        return;
      }

      // Update layer data in context
      updateLayerData(data);

      // Create GEE code snippet and download URL
      const codeType = dataType === 'historical'
        ? 'historical'
        : dataType === 'waterRegimeChange'
        ? 'water_regime_change'
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
      if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
        return;
      }
      if (requestIdRef.current !== requestId || appModeRef.current !== 'ask') {
        return;
      }
      console.error('Error fetching map data:', error);
      setWarning('Error loading map data. Please try again.');
    } finally {
      if (activeRequestControllerRef.current === controller) {
        activeRequestControllerRef.current = null;
      }
      if (requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [dataType, yearControl, setIsLoading, setWarning, updateLayerData, setGeeCodeUrl]);

  // Auto-fetch when AOI is selected or data type changes
  useEffect(() => {
    if (appMode !== 'ask') {
      activeRequestControllerRef.current?.abort();
      prevAoiKeyRef.current = '';
      requestIdRef.current += 1;
      setIsLoading(false);
      return;
    }

    if (selectedAOI && isAskAutoloadAoi(selectedAOI)) {
      console.log('selectedAOI changed:', selectedAOI);
      const currentAoiKey = buildAoiRequestKey(selectedAOI);
      
      if (currentAoiKey !== prevAoiKeyRef.current) {
        console.log('Fetching map data for new AOI...');
        prevAoiKeyRef.current = currentAoiKey;
        fetchMapData(selectedAOI);
      }
    } else {
      activeRequestControllerRef.current?.abort();
      prevAoiKeyRef.current = '';
      requestIdRef.current += 1;
      setIsLoading(false);
    }
  }, [appMode, selectedAOI, fetchMapData, setIsLoading]);

  useEffect(() => {
    activeRequestControllerRef.current?.abort();
    requestIdRef.current += 1;
    prevAoiKeyRef.current = '';
    setIsLoading(false);
  }, [aoiClearVersion, setIsLoading]);

  useEffect(() => () => {
    activeRequestControllerRef.current?.abort();
  }, []);

  // Also refetch when dataType or yearControl changes (if grid is selected)
  useEffect(() => {
    if (appMode === 'ask' && selectedAOI && isAskAutoloadAoi(selectedAOI) && prevAoiKeyRef.current) {
      fetchMapData(selectedAOI);
    }
  }, [appMode, dataType, yearControl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { fetchMapData };
};

export default useMapData;
