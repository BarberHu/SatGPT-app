import { startTransition, useEffect, useMemo } from 'react';
import { useCoAgent } from '@copilotkit/react-core';
import { useAppContext } from '../context/AppContext';
import { DEFAULT_FLOOD_AGENT_STATE } from '../config/floodAgentState';
import useFloodAgentStateAdapter, { areAoiScopesEquivalent } from '../hooks/useFloodAgentStateAdapter';
import useFloodAnalysisRequests from '../hooks/useFloodAnalysisRequests';
import { buildAoiFromAgentState, buildAoiSignature } from '../utils/aoi';
import { isBusinessLayerAoiSource } from '../utils/businessLayerStore';
import { canStartFloodAnalysis } from '../utils/floodWorkflow';

// Scope synchronization and event requests must outlive individual module panels.
export default function FloodAgentViewSync() {
  const {
    agentAnalysisContext, setAgentAnalysisContext, selectedAOI,
    agentShowPopulationLayer, agentShowUrbanLayer, agentShowLandcoverLayer,
    setAgentShowFloodDetection, setAgentShowPopulationLayer, setAgentShowUrbanLayer,
    setAgentShowLandcoverLayer, agentImpactData, agentImpactLoading,
    setAgentImagery, setAgentFloodImageryLoading, setAgentImpactData,
    setAgentImpactLoading, setAgentTileError, setWarning,
  } = useAppContext();
  const { state } = useCoAgent({ name: 'flood_agent', initialState: DEFAULT_FLOOD_AGENT_STATE });
  const { currentState, hasCoAgentState, viewState } = useFloodAgentStateAdapter({ state, fallbackState: agentAnalysisContext });
  useEffect(() => {
    if (hasCoAgentState) {
      startTransition(() => setAgentAnalysisContext(viewState));
    }
  }, [hasCoAgentState, setAgentAnalysisContext, viewState]);

  const aoi = useMemo(() => buildAoiFromAgentState(currentState), [currentState]);
  const scopeMatches = !isBusinessLayerAoiSource(selectedAOI?.source)
    || areAoiScopesEquivalent(selectedAOI, aoi);
  const enabled = canStartFloodAnalysis(currentState, aoi) && scopeMatches;
  const effectiveAoi = enabled ? aoi : null;
  useFloodAnalysisRequests({
    analysisDisplayEnabled: enabled,
    currentPreDate: currentState.pre_date,
    currentPeekDate: currentState.peek_date,
    currentAfterDate: currentState.after_date,
    currentCoordinates: currentState.coordinates,
    currentBounds: currentState.bounds,
    currentGeojson: currentState.geojson,
    effectiveAoi,
    effectiveAoiSignature: buildAoiSignature(effectiveAoi, currentState.bounds),
    impactLayerVisible: agentShowPopulationLayer || agentShowUrbanLayer || agentShowLandcoverLayer,
    agentImpactData, agentImpactLoading, setAgentImagery,
    setAgentImageryLoading: setAgentFloodImageryLoading,
    setAgentImpactData, setAgentImpactLoading, setAgentTileError, setWarning,
  });
  useEffect(() => {
    setAgentShowFloodDetection(enabled && currentState.selected_layer_ids.includes('core:flood_detection'));
    setAgentShowPopulationLayer(false);
    setAgentShowUrbanLayer(false);
    setAgentShowLandcoverLayer(false);
  }, [enabled, currentState.confirmation_version, currentState.selected_layer_ids,
    setAgentShowFloodDetection, setAgentShowPopulationLayer, setAgentShowUrbanLayer,
    setAgentShowLandcoverLayer]);
  return null;
}
