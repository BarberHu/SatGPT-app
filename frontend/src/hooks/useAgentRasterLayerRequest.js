import { useCallback, useRef } from 'react';
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

  return useCallback(async ({ layerKey, params, requestKey, errorMessage }) => {
    const requestAoiSignature = currentAoiSignatureRef.current;
    pendingRequestsRef.current[layerKey] = requestKey;
    setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: true }));

    try {
      const result = await getAgentRasterLayers(params);
      const requestIsCurrent = (
        currentAoiSignatureRef.current === requestAoiSignature
        && pendingRequestsRef.current[layerKey] === requestKey
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
        && pendingRequestsRef.current[layerKey] === requestKey
      );
      if (requestIsCurrent) {
        setWarning(error?.message || errorMessage || 'Raster layer request failed.');
      }
    } finally {
      if (pendingRequestsRef.current[layerKey] === requestKey) {
        delete pendingRequestsRef.current[layerKey];
        setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: false }));
      }
    }
  }, [mergeLayerData, setAgentLayerLoading, setWarning]);
}
