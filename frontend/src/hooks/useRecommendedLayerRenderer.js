import { useEffect, useRef } from 'react';
import { renderRecommendedLayer } from '../services/agentApi';
import { startAgentDiagnosticSpan } from '../utils/agentDiagnostics';

const RECOMMENDED_LAYER_MAX_CONCURRENCY = 2;

export default function useRecommendedLayerRenderer({
  agentRecommendedLayerData,
  agentRecommendedLayerVisibility,
  canRenderCatalogLayer,
  catalogRenderAoi,
  controlPanelCatalogLayers,
  currentAfterDate,
  currentPeekDate,
  currentPreDate,
  getCatalogLayerDateWindow,
  getRecommendedLayerContextKey,
  recommendedLayerBaseContextKey,
  setAgentLayerLoading,
  setAgentRecommendedLayerData,
  setWarning,
}) {
  const pendingRequestsRef = useRef(new Set());
  const recommendedLayerDataRef = useRef(agentRecommendedLayerData);

  useEffect(() => {
    recommendedLayerDataRef.current = agentRecommendedLayerData;
  }, [agentRecommendedLayerData]);

  useEffect(() => {
    const catalogLayersById = new Map(
      controlPanelCatalogLayers.map((layer) => [layer.id, layer])
    );

    setAgentRecommendedLayerData((previous) => {
      let changed = false;
      const next = {};

      Object.entries(previous || {}).forEach(([layerId, descriptor]) => {
        const layer = catalogLayersById.get(layerId);
        if (layer && descriptor?.context_key === getRecommendedLayerContextKey(layer)) {
          next[layerId] = descriptor;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [controlPanelCatalogLayers, getRecommendedLayerContextKey, setAgentRecommendedLayerData]);

  useEffect(() => {
    pendingRequestsRef.current.clear();
  }, [recommendedLayerBaseContextKey]);

  useEffect(() => {
    const visibleCatalogLayers = controlPanelCatalogLayers.filter((layer) => (
      agentRecommendedLayerVisibility[layer.id] && canRenderCatalogLayer(layer)
    ));
    if (!catalogRenderAoi || !visibleCatalogLayers.length) {
      return undefined;
    }

    let cancelled = false;
    const requestController = new AbortController();
    const pendingRequests = pendingRequestsRef.current;
    const layerRequestsToRender = visibleCatalogLayers.map((layer) => {
      const contextKey = getRecommendedLayerContextKey(layer);
      return {
        layer,
        contextKey,
        requestToken: `${contextKey}:${layer.id}`,
      };
    }).filter(({ layer, contextKey, requestToken }) => {
      const cached = recommendedLayerDataRef.current?.[layer.id];
      return !(
        (cached?.tile_url && cached?.context_key === contextKey)
        || pendingRequests.has(requestToken)
      );
    });

    if (!layerRequestsToRender.length) {
      return undefined;
    }

    const processLayer = async ({ layer, contextKey, requestToken }) => {
      const finishLayerSpan = startAgentDiagnosticSpan('layer', 'render_recommended_layer', {
        requestToken,
        layerId: layer.id,
        layerTitle: layer.title || layer.id,
      });

      pendingRequests.add(requestToken);
      setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: true }));

      try {
        const layerDateWindow = getCatalogLayerDateWindow(layer);
        const result = await renderRecommendedLayer({
          layer_id: layer.id,
          recommended_layers: controlPanelCatalogLayers,
          confirmed_aoi: catalogRenderAoi,
          pre_date: layerDateWindow.start_date || currentPreDate,
          peek_date: currentPeekDate || layerDateWindow.start_date,
          after_date: layerDateWindow.end_date || currentAfterDate,
        }, { signal: requestController.signal });

        if (cancelled || !result?.success) {
          finishLayerSpan({ status: cancelled ? 'cancelled' : 'unsuccessful' });
          return;
        }

        setAgentRecommendedLayerData((previous) => ({
          ...previous,
          [layer.id]: {
            ...result.data,
            context_key: contextKey,
          },
        }));
        finishLayerSpan({ status: 'success', hasTileUrl: Boolean(result?.data?.tile_url) });
      } catch (error) {
        if (!cancelled && !error?.isCanceled) {
          setWarning(error?.message || 'Failed to render recommended layer.');
        }
        finishLayerSpan({
          status: cancelled || error?.isCanceled ? 'cancelled' : 'error',
          error: error?.message || 'unknown',
        });
      } finally {
        pendingRequests.delete(requestToken);
        if (!cancelled) {
          setAgentLayerLoading((previous) => ({ ...previous, [layer.id]: false }));
        }
      }
    };

    const runRenderQueue = async () => {
      for (
        let index = 0;
        index < layerRequestsToRender.length && !cancelled;
        index += RECOMMENDED_LAYER_MAX_CONCURRENCY
      ) {
        const batch = layerRequestsToRender.slice(
          index,
          index + RECOMMENDED_LAYER_MAX_CONCURRENCY
        );
        await Promise.allSettled(batch.map((request) => processLayer(request)));
      }
    };

    runRenderQueue();

    return () => {
      cancelled = true;
      requestController.abort();
      layerRequestsToRender.forEach(({ requestToken }) => {
        pendingRequests.delete(requestToken);
      });
      setAgentLayerLoading((previous) => {
        let changed = false;
        const next = { ...previous };
        layerRequestsToRender.forEach(({ layer }) => {
          if (next[layer.id]) {
            next[layer.id] = false;
            changed = true;
          }
        });
        return changed ? next : previous;
      });
    };
  }, [
    agentRecommendedLayerVisibility,
    canRenderCatalogLayer,
    catalogRenderAoi,
    controlPanelCatalogLayers,
    currentAfterDate,
    currentPeekDate,
    currentPreDate,
    getCatalogLayerDateWindow,
    getRecommendedLayerContextKey,
    setAgentLayerLoading,
    setAgentRecommendedLayerData,
    setWarning,
  ]);
}
