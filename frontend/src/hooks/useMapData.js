import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { getHistoricalMap, getFloodHotspotMap, createCodeSnippet } from '../services/api';

const FLOOD_HOTSPOT_YEAR_FROM = 1988;

export const useMapData = () => {
  const {
    selectedGridCords,
    dataType,
    yearControl,
    setIsLoading,
    setWarning,
    updateLayerData,
    setGeeCodeUrl,
  } = useAppContext();

  // Track previous grid coords to detect changes
  const prevGridCordsRef = useRef(null);

  // Fetch map data when grid is selected
  const fetchMapData = useCallback(async (gridCords) => {
    if (!gridCords) return;

    console.log('fetchMapData called with:', gridCords);

    // Build parameters
    const geoJsonList = gridCords.map((coords) => [coords[0], coords[1]]);
    
    const params = {
      AoI_cords: JSON.stringify(geoJsonList),
      time_start: '2010-01-01',
      time_end: '2024-12-31',
      cloud_mask: 'true',
      climatology: 'false',
      month_from: '1',
      month_to: '12',
    };

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

      // Update layer data in context
      updateLayerData(data);

      // Create GEE code snippet and download URL
      const codeType = dataType === 'historical' ? 'historical' : 'flood_hotspot';
      const codeSnippet = createCodeSnippet(params, codeType);
      if (codeSnippet) {
        const blob = new Blob([codeSnippet], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        setGeeCodeUrl(url);
        console.log('GEE code URL created:', url);
      }

    } catch (error) {
      console.error('Error fetching map data:', error);
      setWarning('Error loading map data. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [dataType, yearControl, setIsLoading, setWarning, updateLayerData, setGeeCodeUrl]);

  // Auto-fetch when grid is selected or data type changes
  useEffect(() => {
    if (selectedGridCords) {
      console.log('selectedGridCords changed:', selectedGridCords);
      // Compare with previous coords using JSON stringify
      const currentCordsStr = JSON.stringify(selectedGridCords);
      const prevCordsStr = JSON.stringify(prevGridCordsRef.current);
      
      // Only fetch if coords changed or it's the first selection
      if (currentCordsStr !== prevCordsStr || !prevGridCordsRef.current) {
        console.log('Fetching map data for new grid...');
        prevGridCordsRef.current = selectedGridCords;
        fetchMapData(selectedGridCords);
      }
    }
  }, [selectedGridCords, fetchMapData]);

  // Also refetch when dataType or yearControl changes (if grid is selected)
  useEffect(() => {
    if (selectedGridCords && prevGridCordsRef.current) {
      fetchMapData(selectedGridCords);
    }
  }, [dataType, yearControl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { fetchMapData };
};

export default useMapData;
