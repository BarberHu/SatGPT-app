export const APP_MODE_ASK = 'ask';
export const APP_MODE_AGENT = 'agent';

const APP_MODES = new Set([APP_MODE_ASK, APP_MODE_AGENT]);

export const isAppMode = (mode) => APP_MODES.has(mode);

export const appModeReducer = (state, action) => {
  if (action?.type !== 'switch' || !isAppMode(action.mode)) {
    return state;
  }
  return action.mode;
};

export const planAppModeTransition = ({
  currentMode,
  nextMode,
  hasFishnetAoi = false,
}) => {
  if (!isAppMode(nextMode) || currentMode === nextMode) {
    return null;
  }

  const enteringAgent = currentMode === APP_MODE_ASK && nextMode === APP_MODE_AGENT;
  const switchesWithAgent = currentMode === APP_MODE_AGENT || nextMode === APP_MODE_AGENT;

  return {
    nextMode,
    resetAsk: enteringAgent || hasFishnetAoi,
    resetAgent: switchesWithAgent,
    clearFishnetAoi: hasFishnetAoi,
    restoreBusinessScope: enteringAgent && !hasFishnetAoi,
  };
};
