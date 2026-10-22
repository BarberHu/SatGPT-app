import { useCallback, useEffect, useRef } from 'react';
import { getFloodImages, getFloodImpact } from '../services/agentApi';
import { buildAoiSignature } from '../utils/aoi';
import { trackUxEvent } from '../utils/analytics';
import { startAgentDiagnosticSpan } from '../utils/agentDiagnostics';
import { finalizeLatestRequest } from '../utils/latestRequest';
import { formatCoordinatePart } from './useFloodAgentStateAdapter';

export default function useFloodAnalysisRequests({
  analysisDisplayEnabled,
  currentAfterDate,
  currentBounds,
  currentCoordinates,
  currentGeojson,
  currentPeekDate,
  currentPreDate,
  effectiveAoi,
  effectiveAoiSignature,
  impactLayerVisible,
  agentImpactData,
  agentImpactLoading,
  setAgentImagery,
  setAgentImageryLoading,
  setAgentImpactData,
  setAgentImpactLoading,
  setAgentTileError,
  setWarning,
}) {
  const imageryRequestKeyRef = useRef(null);
  const impactRequestKeyRef = useRef(null);
  const imageryAbortControllerRef = useRef(null);
  const impactAbortControllerRef = useRef(null);

  useEffect(() => () => {
    imageryAbortControllerRef.current?.abort();
    imageryAbortControllerRef.current = null;
    impactAbortControllerRef.current?.abort();
    impactAbortControllerRef.current = null;
  }, []);

  const fetchAgentImagery = useCallback(async (agentState, aoi) => {
    const requestKey = [
      agentState.pre_date || '',
      agentState.peek_date || '',
      agentState.after_date || '',
      buildAoiSignature(aoi, agentState.bounds),
      formatCoordinatePart(agentState.coordinates?.[0]),
      formatCoordinatePart(agentState.coordinates?.[1]),
    ].join('|');

    if (imageryRequestKeyRef.current === requestKey) {
      return;
    }

    const previousController = imageryAbortControllerRef.current;
    const requestController = new AbortController();
    imageryRequestKeyRef.current = requestKey;
    imageryAbortControllerRef.current = requestController;
    previousController?.abort();
    impactAbortControllerRef.current?.abort();
    impactAbortControllerRef.current = null;
    impactRequestKeyRef.current = null;
    setAgentImpactLoading(false);
    setAgentImagery(null);
    setAgentImpactData(null);
    setAgentTileError(null);
    setAgentImageryLoading(true);
    setWarning('');

    const finishImagerySpan = startAgentDiagnosticSpan('network', 'flood_images', {
      requestKey,
      aoiSource: aoi?.source || 'agent',
      hasBounds: Boolean(aoi?.bounds || agentState.bounds),
      hasGeojson: Boolean(aoi?.geojson?.geometry || agentState.geojson?.geometry),
      preDate: agentState.pre_date || null,
      peekDate: agentState.peek_date || null,
      afterDate: agentState.after_date || null,
    });
    let releaseRequestKeyForRetry = false;

    try {
      const result = await getFloodImages({
        pre_date: agentState.pre_date,
        peek_date: agentState.peek_date,
        after_date: agentState.after_date,
        longitude: agentState.coordinates?.[0] || 0,
        latitude: agentState.coordinates?.[1] || 0,
        bounds: aoi?.bounds || agentState.bounds || null,
        geojson: aoi?.geojson?.geometry || agentState.geojson?.geometry || null,
      }, { signal: requestController.signal });

      if (imageryRequestKeyRef.current !== requestKey) {
        finishImagerySpan({ status: 'stale' });
        return;
      }

      if (!result?.success) {
        throw new Error('Flood imagery response was not successful.');
      }

      setAgentImagery(result.data);
      setWarning('');
      finishImagerySpan({
        status: 'success',
        hasFloodDetection: Boolean(result?.data?.flood_detection),
        periods: Object.keys(result?.data || {}).filter((key) => key.endsWith('_date')),
      });
      trackUxEvent('imagery_request_success', {
        source: aoi?.source || 'agent',
        mode: 'agent',
      });
    } catch (error) {
      if (error?.isCanceled) {
        finishImagerySpan({ status: 'cancelled' });
        return;
      }
      if (imageryRequestKeyRef.current !== requestKey) {
        return;
      }
      console.error('Failed to fetch imagery:', error);
      releaseRequestKeyForRetry = true;
      finishImagerySpan({ status: 'error', error: error?.message || 'unknown' });
      setWarning(error?.message || 'Flood imagery request failed.');
      trackUxEvent('imagery_request_fail', {
        mode: 'agent',
        error: error?.message || 'Unknown imagery error',
      });
    } finally {
      if (imageryAbortControllerRef.current === requestController) {
        imageryAbortControllerRef.current = null;
      }
      finalizeLatestRequest({
        requestKeyRef: imageryRequestKeyRef,
        requestKey,
        setLoading: setAgentImageryLoading,
        releaseForRetry: releaseRequestKeyForRetry,
      });
    }
  }, [
    setAgentImagery,
    setAgentImageryLoading,
    setAgentImpactData,
    setAgentImpactLoading,
    setAgentTileError,
    setWarning,
  ]);

  useEffect(() => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate || !currentAfterDate) {
      imageryAbortControllerRef.current?.abort();
      imageryAbortControllerRef.current = null;
      impactAbortControllerRef.current?.abort();
      impactAbortControllerRef.current = null;
      imageryRequestKeyRef.current = null;
      impactRequestKeyRef.current = null;
      setAgentImageryLoading(false);
      setAgentImpactLoading(false);
      return;
    }

    if (effectiveAoi || currentCoordinates) {
      fetchAgentImagery({
        pre_date: currentPreDate,
        peek_date: currentPeekDate,
        after_date: currentAfterDate,
        coordinates: currentCoordinates,
        bounds: currentBounds,
        geojson: currentGeojson,
      }, effectiveAoi);
    }
  }, [
    analysisDisplayEnabled,
    currentAfterDate,
    currentBounds,
    currentCoordinates,
    currentGeojson,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
    fetchAgentImagery,
    setAgentImageryLoading,
    setAgentImpactLoading,
  ]);

  const fetchImpactData = useCallback(async () => {
    if (!analysisDisplayEnabled || !currentPreDate || !currentPeekDate) {
      return;
    }

    const requestKey = [currentPreDate, currentPeekDate, effectiveAoiSignature].join('|');
    if (impactRequestKeyRef.current === requestKey) {
      return;
    }

    const previousController = impactAbortControllerRef.current;
    const requestController = new AbortController();
    impactRequestKeyRef.current = requestKey;
    impactAbortControllerRef.current = requestController;
    previousController?.abort();
    setAgentImpactLoading(true);
    setWarning('');
    const finishImpactSpan = startAgentDiagnosticSpan('network', 'flood_impact', {
      requestKey,
      aoiSource: effectiveAoi?.source || 'agent',
      hasBounds: Boolean(effectiveAoi?.bounds || currentBounds),
      hasGeojson: Boolean(effectiveAoi?.geojson?.geometry || currentGeojson),
      preDate: currentPreDate || null,
      peekDate: currentPeekDate || null,
    });
    let releaseRequestKeyForRetry = false;

    try {
      const result = await getFloodImpact({
        pre_date: currentPreDate,
        peek_date: currentPeekDate,
        bounds: effectiveAoi?.bounds || currentBounds || null,
        geojson: effectiveAoi?.geojson?.geometry || currentGeojson || null,
      }, { signal: requestController.signal });

      if (impactRequestKeyRef.current !== requestKey) {
        finishImpactSpan({ status: 'stale' });
        return;
      }

      if (result?.success) {
        setAgentImpactData(result.data);
        setWarning('');
        finishImpactSpan({ status: 'success', keys: Object.keys(result?.data || {}) });
        trackUxEvent('impact_request_success', {
          mode: 'agent',
          source: effectiveAoi?.source || 'agent',
        });
      }
    } catch (error) {
      if (error?.isCanceled) {
        finishImpactSpan({ status: 'cancelled' });
        return;
      }
      if (impactRequestKeyRef.current !== requestKey) {
        return;
      }
      console.error('Failed to fetch impact data:', error);
      releaseRequestKeyForRetry = true;
      finishImpactSpan({ status: 'error', error: error?.message || 'unknown' });
      setWarning(error?.message || 'Flood impact request failed.');
      trackUxEvent('impact_request_fail', {
        mode: 'agent',
        error: error?.message || 'Unknown impact error',
      });
    } finally {
      if (impactAbortControllerRef.current === requestController) {
        impactAbortControllerRef.current = null;
      }
      finalizeLatestRequest({
        requestKeyRef: impactRequestKeyRef,
        requestKey,
        setLoading: setAgentImpactLoading,
        releaseForRetry: releaseRequestKeyForRetry,
      });
    }
  }, [
    analysisDisplayEnabled,
    currentBounds,
    currentGeojson,
    currentPeekDate,
    currentPreDate,
    effectiveAoi,
    effectiveAoiSignature,
    setAgentImpactData,
    setAgentImpactLoading,
    setWarning,
  ]);

  useEffect(() => {
    if (analysisDisplayEnabled && impactLayerVisible && !agentImpactData && !agentImpactLoading) {
      fetchImpactData();
    }
  }, [
    agentImpactData,
    agentImpactLoading,
    analysisDisplayEnabled,
    fetchImpactData,
    impactLayerVisible,
  ]);

  return { fetchAgentImagery, fetchImpactData };
}
