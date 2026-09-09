import { useCallback, useEffect, useRef } from 'react';
import { getAgentRasterLayers } from '../services/api';

export default function useAgentRasterLayerRequest({
  aoiSignature,
  mergeLayerData,
  setAgentLayerLoading,
  setWarning,
}) {
  const currentAoiSignatureRef = useRef(aoiSignature);
  const pendingRequestsRef = useRef({});
  currentAoiSignatureRef.current = aoiSignature;

  useEffect(() => () => {
    Object.values(pendingRequestsRef.current).forEach(({ controller }) => {
      controller.abort();
    });
    pendingRequestsRef.current = {};
  }, []);

  return useCallback(async ({ layerKey, params, requestKey, errorMessage }) => {
    const requestAoiSignature = currentAoiSignatureRef.current;
    pendingRequestsRef.current[layerKey]?.controller.abort();
    const controller = new AbortController();
    const request = { controller, requestKey };
    pendingRequestsRef.current[layerKey] = request;
    setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: true }));

    try {
      const result = await getAgentRasterLayers(params, { signal: controller.signal });
      const requestIsCurrent = (
        currentAoiSignatureRef.current === requestAoiSignature
        && pendingRequestsRef.current[layerKey] === request
      );
      if (!requestIsCurrent) {
        return;
      }

      mergeLayerData(result, {
        aoiSignature: requestAoiSignature,
        requestKey,
      });
      setWarning('');
    } catch (error) {
      const requestIsCurrent = (
        currentAoiSignatureRef.current === requestAoiSignature
        && pendingRequestsRef.current[layerKey] === request
      );
      if (requestIsCurrent && !error?.isCanceled) {
        setWarning(error?.message || errorMessage || 'Raster layer request failed.');
      }
    } finally {
      if (pendingRequestsRef.current[layerKey] === request) {
        delete pendingRequestsRef.current[layerKey];
        setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: false }));
      }
    }
  }, [mergeLayerData, setAgentLayerLoading, setWarning]);
}
