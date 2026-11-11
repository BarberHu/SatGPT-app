import {
  APP_MODE_AGENT,
  APP_MODE_ASK,
  appModeReducer,
  planAppModeTransition,
} from './appModeReducer';

describe('appModeReducer', () => {
  test('switches between the supported modes', () => {
    expect(appModeReducer(APP_MODE_ASK, {
      type: 'switch',
      mode: APP_MODE_AGENT,
    })).toBe(APP_MODE_AGENT);
  });

  test('ignores unsupported modes', () => {
    expect(appModeReducer(APP_MODE_ASK, {
      type: 'switch',
      mode: 'unknown',
    })).toBe(APP_MODE_ASK);
  });
});

describe('planAppModeTransition', () => {
  test('centralizes Ask cleanup and Agent reset when entering Agent mode', () => {
    expect(planAppModeTransition({
      currentMode: APP_MODE_ASK,
      nextMode: APP_MODE_AGENT,
    })).toEqual({
      nextMode: APP_MODE_AGENT,
      resetAsk: true,
      resetAgent: true,
      clearFishnetAoi: false,
      restoreBusinessScope: true,
    });
  });

  test('resets Agent state when returning to Ask mode', () => {
    expect(planAppModeTransition({
      currentMode: APP_MODE_AGENT,
      nextMode: APP_MODE_ASK,
    })).toEqual({
      nextMode: APP_MODE_ASK,
      resetAsk: false,
      resetAgent: true,
      clearFishnetAoi: false,
      restoreBusinessScope: false,
    });
  });

  test('clears a fishnet AOI during a mode transition', () => {
    expect(planAppModeTransition({
      currentMode: APP_MODE_ASK,
      nextMode: APP_MODE_AGENT,
      hasFishnetAoi: true,
    })).toEqual({
      nextMode: APP_MODE_AGENT,
      resetAsk: true,
      resetAgent: true,
      clearFishnetAoi: true,
      restoreBusinessScope: false,
    });
  });

  test('does not schedule work when the mode is unchanged', () => {
    expect(planAppModeTransition({
      currentMode: APP_MODE_ASK,
      nextMode: APP_MODE_ASK,
    })).toBeNull();
  });
});
