import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { getHistoricalMap, getFloodHotspotMap, createCodeSnippet } from '../services/api';
import { buildAskMapRequestParams } from '../utils/aoi';

const FLOOD_HOTSPOT_YEAR_FROM = 1988;

export const useMapData = () => {
  const {
    selectedAOI,
    dataType,
    yearControl,
    setIsLoading,
    setWarning,
    updateLayerData,
    setGeeCodeUrl,
  } = useAppContext();

  // Track previous grid coords to detect changes
  const prevAoiRef = useRef(null);
  const requestIdRef = useRef(0);

  // Fetch map data when grid is selected
  const fetchMapData = useCallback(async (aoi) => {
    if (!aoi) return;
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
    setIsLoading(true);
    setWarning('');

    try {
      let data;
      
      if (dataType === 'historical') {
        data = await getHistoricalMap(params);
      } else {
        // Flood hotspot
        params.year_from = FLOOD_HOTSPOT_YEAR_FROM;
        params.year_count = yearControl;
        data = await getFloodHotspotMap(params);
      }

      if (requestIdRef.current !== requestId) {
        return;
      }

      // Update layer data in context
      updateLayerData(data);

      // Create GEE code snippet and download URL
      const codeType = dataType === 'historical' ? 'historical' : 'flood_hotspot';
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
      if (requestIdRef.current !== requestId) {
        return;
      }
      console.error('Error fetching map data:', error);
      setWarning('Error loading map data. Please try again.');
    } finally {
      if (requestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [dataType, yearControl, setIsLoading, setWarning, updateLayerData, setGeeCodeUrl]);

  // Auto-fetch when AOI is selected or data type changes
  useEffect(() => {
    if (selectedAOI) {
      console.log('selectedAOI changed:', selectedAOI);
      const currentAoiStr = JSON.stringify(selectedAOI);
      const prevAoiStr = JSON.stringify(prevAoiRef.current);
      
      if (currentAoiStr !== prevAoiStr || !prevAoiRef.current) {
        console.log('Fetching map data for new AOI...');
        prevAoiRef.current = selectedAOI;
        fetchMapData(selectedAOI);
      }
    } else {
      prevAoiRef.current = null;
      requestIdRef.current += 1;
    }
  }, [selectedAOI, fetchMapData]);

  // Also refetch when dataType or yearControl changes (if grid is selected)
  useEffect(() => {
    if (selectedAOI && prevAoiRef.current) {
      fetchMapData(selectedAOI);
    }
  }, [dataType, yearControl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { fetchMapData };
};

export default useMapData;
