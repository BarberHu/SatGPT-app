import { useEffect, useRef } from 'react';

const STORAGE_KEY = 'satgpt.agentDiagnostics';
const DEFAULT_ENABLED = process.env.NODE_ENV !== 'production';

const readStoredFlag = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.localStorage?.getItem(STORAGE_KEY);
    if (value === '1' || value === 'true') {
      return true;
    }
    if (value === '0' || value === 'false') {
      return false;
    }
  } catch (_error) {
    return null;
  }

  return null;
};

export const isAgentDiagnosticsEnabled = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (typeof window.__SATGPT_AGENT_DIAGNOSTICS__ === 'boolean') {
    return window.__SATGPT_AGENT_DIAGNOSTICS__;
  }

  const storedFlag = readStoredFlag();
  if (typeof storedFlag === 'boolean') {
    return storedFlag;
  }

  return DEFAULT_ENABLED;
};

const now = () => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
};

const round = (value) => {
  if (!Number.isFinite(Number(value))) {
    return value ?? null;
  }

  return Math.round(Number(value) * 10) / 10;
};

export const logAgentDiagnostic = (channel, event, payload = {}) => {
  if (!isAgentDiagnosticsEnabled()) {
    return;
  }

  const safePayload = {
    timestamp: new Date().toISOString(),
    ...payload,
  };

  console.debug(`[SATGPT:${channel}] ${event}`, safePayload);
};

export const startAgentDiagnosticSpan = (channel, event, payload = {}) => {
  if (!isAgentDiagnosticsEnabled()) {
    return () => {};
  }

  const startedAt = now();
  let completed = false;

  logAgentDiagnostic(channel, `${event}:start`, payload);

  return (extra = {}) => {
    if (completed) {
      return;
    }

    completed = true;
    logAgentDiagnostic(channel, `${event}:end`, {
      ...payload,
      ...extra,
      durationMs: round(now() - startedAt),
    });
  };
};

export const updateAgentDiagnosticsContext = (patch = {}) => {
  if (!isAgentDiagnosticsEnabled() || typeof window === 'undefined') {
    return;
  }

  window.__SATGPT_AGENT_DIAGNOSTICS_CONTEXT__ = {
    ...(window.__SATGPT_AGENT_DIAGNOSTICS_CONTEXT__ || {}),
    ...patch,
  };
};

export const installLongTaskObserver = () => {
  if (!isAgentDiagnosticsEnabled() || typeof PerformanceObserver === 'undefined') {
    return () => {};
  }

  if (!Array.isArray(PerformanceObserver.supportedEntryTypes) || !PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    logAgentDiagnostic('perf', 'longtask_unsupported');
    return () => {};
  }

  const observer = new PerformanceObserver((list) => {
    const diagnosticContext = typeof window !== 'undefined'
      ? window.__SATGPT_AGENT_DIAGNOSTICS_CONTEXT__ || {}
      : {};

    list.getEntries().forEach((entry) => {
      logAgentDiagnostic('longtask', 'main_thread_blocked', {
        name: entry.name,
        startTimeMs: round(entry.startTime),
        durationMs: round(entry.duration),
        ...diagnosticContext,
      });
    });
  });

  observer.observe({ entryTypes: ['longtask'] });
  logAgentDiagnostic('perf', 'longtask_observer_started');

  return () => observer.disconnect();
};

export const createReactProfilerHandler = (componentName, detailsFactory) => (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (!isAgentDiagnosticsEnabled()) {
    return;
  }

  const shouldLog = phase === 'mount' || actualDuration >= 8;
  if (!shouldLog) {
    return;
  }

  logAgentDiagnostic('profiler', componentName, {
    profilerId: id,
    phase,
    actualDurationMs: round(actualDuration),
    baseDurationMs: round(baseDuration),
    startTimeMs: round(startTime),
    commitTimeMs: round(commitTime),
    ...(typeof detailsFactory === 'function' ? detailsFactory() : {}),
  });
};

export const useRenderDiagnostics = (componentName, detailsFactory, options = {}) => {
  const renderRef = useRef({
    count: 0,
    lastRenderAt: 0,
  });

  useEffect(() => {
    if (!isAgentDiagnosticsEnabled()) {
      return;
    }

    const renderedAt = now();
    const sinceLastRenderMs = renderRef.current.lastRenderAt
      ? renderedAt - renderRef.current.lastRenderAt
      : null;

    renderRef.current.count += 1;
    renderRef.current.lastRenderAt = renderedAt;

    const initialLogs = options.initialLogs ?? 5;
    const every = options.every ?? 25;
    const stormThresholdMs = options.stormThresholdMs ?? 120;
    const shouldLog = (
      renderRef.current.count <= initialLogs
      || (sinceLastRenderMs !== null && sinceLastRenderMs <= stormThresholdMs)
      || renderRef.current.count % every === 0
    );

    if (!shouldLog) {
      return;
    }

    logAgentDiagnostic('render', componentName, {
      renderCount: renderRef.current.count,
      sinceLastRenderMs: round(sinceLastRenderMs),
      ...(typeof detailsFactory === 'function' ? detailsFactory() : {}),
    });
  });
};
