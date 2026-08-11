import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAgentRasterLayers } from '../services/api';
import { getFloodImages } from '../services/agentApi';
import {
  buildAoiSignature,
  buildAskMapRequestParams,
  resolveAgentAnalysisAoi,
} from '../utils/aoi';
import { useAppContext } from '../context/AppContext';
import useAgentRasterDownload from '../hooks/useAgentRasterDownload';
import LayerManager from './LayerManager';
import 'rc-slider/assets/index.css';
import './AgentPanel.css';
import './WildfirePanel.css';

const DEFAULT_DETECTION_WINDOW = 30;
const DEFAULT_DETECTION_WINDOW_MIN = 1;
const DEFAULT_DETECTION_WINDOW_MAX = 365;
const DEFAULT_RISK_WINDOW = 60;
const DEFAULT_RISK_WINDOW_MIN = 7;
const DEFAULT_RISK_WINDOW_MAX = 365;

const formatDate = (date) => date.toISOString().slice(0, 10);

const buildRecentDateWindow = (dayCount = DEFAULT_RISK_WINDOW) => {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(dayCount) || DEFAULT_RISK_WINDOW) + 1);
  return {
    time_start: formatDate(start),
    time_end: formatDate(end),
  };
};

const marksFromTicks = (ticks = []) => ticks.reduce((marks, tick) => ({
  ...marks,
  [tick]: String(tick),
}), {});

const clampWindowValue = (value, minValue, maxValue, fallbackValue) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallbackValue;
  }
  return Math.min(maxValue, Math.max(minValue, Math.trunc(numericValue)));
};

const normalizeImageryDateWindow = (window = {}, eventDates = {}) => {
  const fallback = buildRecentDateWindow(DEFAULT_DETECTION_WINDOW);
  const eventStart = eventDates.pre_date || eventDates.peek_date || '';
  const eventEnd = eventDates.after_date || eventDates.peek_date || eventStart;
  const startDate = String(
    window.start_date
    || eventStart
    || fallback.time_start
  ).slice(0, 10);
  const endDate = String(
    window.end_date
    || eventEnd
    || (eventStart ? startDate : fallback.time_end)
  ).slice(0, 10);
  return {
    start_date: startDate,
    end_date: endDate,
  };
};

const isValidImageryDateWindow = (window) => Boolean(
  window?.start_date
  && window?.end_date
  && window.start_date <= window.end_date
);

const getLayerWindowConfig = (layer) => {
  if (!layer) {
    return null;
  }

  if (layer.hasRecentWindowControl) {
    const min = layer.minRecentWindow || DEFAULT_RISK_WINDOW_MIN;
    const max = layer.maxRecentWindow || DEFAULT_RISK_WINDOW_MAX;
    const defaultValue = clampWindowValue(layer.defaultRecentWindow, min, max, DEFAULT_RISK_WINDOW);
    const ticks = layer.recentWindowTicks || [min, defaultValue, max];
    return {
      label: layer.recentWindowLabel || 'Risk window',
      defaultValue,
      min,
      max,
      ticks,
      marks: marksFromTicks(ticks),
      helpText: layer.recentWindowHelpText || 'Uses the selected recent window ending today.',
    };
  }

  if (layer.hasDetectionWindowControl) {
    const min = layer.minDetectionWindow || DEFAULT_DETECTION_WINDOW_MIN;
    const max = layer.maxDetectionWindow || DEFAULT_DETECTION_WINDOW_MAX;
    const defaultValue = clampWindowValue(layer.defaultDetectionWindow, min, max, DEFAULT_DETECTION_WINDOW);
    const ticks = layer.detectionWindowTicks || [min, defaultValue, max];
    return {
      label: 'Detection window',
      defaultValue,
      min,
      max,
      ticks,
      marks: marksFromTicks(ticks),
      helpText: layer.detectionWindowHelpText || 'Detections are filtered to the selected recent window ending today.',
    };
  }

  return null;
};

const buildDefaultLayerWindows = (layers = []) => (
  (layers || []).reduce((windows, layer) => {
    const windowConfig = getLayerWindowConfig(layer);
    if (windowConfig) {
      windows[layer.key] = windowConfig.defaultValue;
    }
    return windows;
  }, {})
);

function DisasterLayerPanel({
  moduleName,
  moduleLabel,
  rasterLayerConfig,
  panelClassName = '',
  showRaster = true,
  showImagery = true,
  showVector = true,
  emptyVectorText = 'Upload, draw, or search an AOI to populate vector layers.',
  downloadTitle = 'GEE code export is not connected yet',
}) {
  const {
    selectedAOI,
    layerData,
    agentRasterLayerVisibility,
    setAgentRasterLayerVisibility,
    setAgentRasterExpectedRequestKeys,
    agentRasterLoading,
    setAgentRasterLoading,
    agentLayerLoading,
    setAgentLayerLoading,
    agentLayerProgress,
    mergeLayerData,
    setWarning,
    floodAgentState,
    agentImagery,
    setAgentImagery,
    agentImageryLoading,
    setAgentImageryLoading,
    agentImageryDateWindow,
    setAgentImageryDateWindow,
    setAgentSelectedPeriod,
    setAgentSelectedType,
    agentShowBaseImagery,
    setAgentShowBaseImagery,
    agentBaseImageryVisibility,
    setAgentBaseImageryVisibility,
    businessLayers,
    toggleBusinessLayerVisibility,
    activateBusinessLayerRecord,
    deleteBusinessLayer,
    agentLayerOrder,
    setAgentLayerOrder,
  } = useAppContext();

  const [layerWindows, setLayerWindows] = useState(() => buildDefaultLayerWindows(rasterLayerConfig));
  const activeAnalysisAoi = useMemo(
    () => resolveAgentAnalysisAoi(selectedAOI),
    [selectedAOI]
  );
  const selectedAoiSignature = useMemo(
    () => buildAoiSignature(activeAnalysisAoi),
    [activeAnalysisAoi]
  );
  const {
    downloadState: rasterDownloadState,
    downloadRaster: handleAgentRasterDownload,
  } = useAgentRasterDownload({ aoi: activeAnalysisAoi, setWarning });
  const imageryRequestKeyRef = useRef(null);
  const resolvedImageryDateWindow = useMemo(
    () => normalizeImageryDateWindow(agentImageryDateWindow, floodAgentState),
    [agentImageryDateWindow, floodAgentState]
  );
  const hasValidImageryDateWindow = isValidImageryDateWindow(resolvedImageryDateWindow);
  const appliedImageryWindow = agentImagery?.imagery_window || null;
  const hasCurrentImageryWindow = Boolean(
    appliedImageryWindow?.start_date === resolvedImageryDateWindow.start_date
    && appliedImageryWindow?.end_date === resolvedImageryDateWindow.end_date
    && agentImagery?.imagery_aoi_signature === selectedAoiSignature
  );

  const handleImageryDateChange = useCallback((fieldKey, nextValue) => {
    const current = normalizeImageryDateWindow(agentImageryDateWindow, floodAgentState);
    let nextStart = fieldKey === 'start_date' ? nextValue : current.start_date;
    let nextEnd = fieldKey === 'end_date' ? nextValue : current.end_date;
    if (nextStart && nextEnd && nextStart > nextEnd) {
      if (fieldKey === 'start_date') {
        nextEnd = nextStart;
      } else {
        nextStart = nextEnd;
      }
    }
    setAgentImageryDateWindow({ start_date: nextStart, end_date: nextEnd });
  }, [agentImageryDateWindow, floodAgentState, setAgentImageryDateWindow]);

  const fetchImageryWindow = useCallback(async () => {
    if (!activeAnalysisAoi) {
      setWarning('Please select an AOI before loading imagery.');
      return;
    }
    if (!hasValidImageryDateWindow) {
      setWarning('Please select a valid imagery start and end date.');
      return;
    }

    const requestKey = [
      selectedAoiSignature,
      resolvedImageryDateWindow.start_date,
      resolvedImageryDateWindow.end_date,
    ].join('|');
    if (imageryRequestKeyRef.current === requestKey && agentImageryLoading) {
      return;
    }

    imageryRequestKeyRef.current = requestKey;
    setAgentSelectedPeriod('custom_range');
    setAgentImageryLoading(true);
    setWarning('');

    try {
      const result = await getFloodImages({
        imagery_start_date: resolvedImageryDateWindow.start_date,
        imagery_end_date: resolvedImageryDateWindow.end_date,
        longitude: activeAnalysisAoi.center?.lng || 0,
        latitude: activeAnalysisAoi.center?.lat || 0,
        bounds: activeAnalysisAoi.bounds || null,
        geojson: activeAnalysisAoi.geojson?.geometry || activeAnalysisAoi.geojson || null,
      });
      if (imageryRequestKeyRef.current !== requestKey) {
        return;
      }
      if (!result?.success) {
        throw new Error('Imagery response was not successful.');
      }
      setAgentImagery((previous) => ({
        ...(previous || {}),
        ...(result.data || {}),
        imagery_aoi_signature: selectedAoiSignature,
      }));
    } catch (error) {
      if (imageryRequestKeyRef.current === requestKey) {
        setWarning(error?.message || 'Imagery request failed.');
      }
    } finally {
      if (imageryRequestKeyRef.current === requestKey) {
        setAgentImageryLoading(false);
      }
    }
  }, [
    activeAnalysisAoi,
    agentImageryLoading,
    hasValidImageryDateWindow,
    resolvedImageryDateWindow,
    selectedAoiSignature,
    setAgentImagery,
    setAgentImageryLoading,
    setAgentSelectedPeriod,
    setWarning,
  ]);

  useEffect(() => {
    if (!showImagery) {
      return;
    }
    setAgentSelectedPeriod('custom_range');
    if (!agentImageryDateWindow?.start_date || !agentImageryDateWindow?.end_date) {
      setAgentImageryDateWindow(resolvedImageryDateWindow);
    }
  }, [
    agentImageryDateWindow,
    resolvedImageryDateWindow,
    setAgentImageryDateWindow,
    setAgentSelectedPeriod,
    showImagery,
  ]);

  useEffect(() => {
    const hasVisibleImagery = Object.values(agentBaseImageryVisibility || {}).some(Boolean);
    const currentRequestKey = [
      selectedAoiSignature,
      resolvedImageryDateWindow.start_date,
      resolvedImageryDateWindow.end_date,
    ].join('|');
    if (
      showImagery
      && hasVisibleImagery
      && activeAnalysisAoi
      && hasValidImageryDateWindow
      && !hasCurrentImageryWindow
      && !agentImageryLoading
      && imageryRequestKeyRef.current !== currentRequestKey
    ) {
      fetchImageryWindow();
    }
  }, [
    activeAnalysisAoi,
    agentBaseImageryVisibility,
    agentImageryLoading,
    fetchImageryWindow,
    hasCurrentImageryWindow,
    hasValidImageryDateWindow,
    resolvedImageryDateWindow,
    selectedAoiSignature,
    showImagery,
  ]);

  const getRasterLayerConfig = useCallback(
    (layerKey) => rasterLayerConfig.find((layer) => layer.key === layerKey) || null,
    [rasterLayerConfig]
  );

  const buildRasterRequestKey = useCallback((layerKey, params = {}) => [
    moduleName,
    layerKey,
    selectedAoiSignature,
    params.time_start || '',
    params.time_end || '',
  ].join('|'), [moduleName, selectedAoiSignature]);

  useEffect(() => {
    setAgentRasterExpectedRequestKeys((previous) => {
      const nextKeys = {};

      rasterLayerConfig.forEach((layer) => {
        const windowConfig = getLayerWindowConfig(layer);
        const windowValue = windowConfig
          ? clampWindowValue(
            layerWindows[layer.key],
            windowConfig.min,
            windowConfig.max,
            windowConfig.defaultValue
          )
          : null;
        const expectedDateWindow = windowConfig ? buildRecentDateWindow(windowValue) : {};
        nextKeys[layer.key] = buildRasterRequestKey(layer.key, expectedDateWindow);
      });

      const hasChanged = Object.entries(nextKeys).some(
        ([layerKey, requestKey]) => previous?.[layerKey] !== requestKey
      );

      return hasChanged ? { ...previous, ...nextKeys } : previous;
    });
  }, [
    buildRasterRequestKey,
    layerWindows,
    rasterLayerConfig,
    setAgentRasterExpectedRequestKeys,
  ]);

  const fetchRasterLayer = useCallback(async (layerKey, overrides = {}) => {
    if (!activeAnalysisAoi) {
      setWarning(`Please select an AOI before loading ${moduleLabel} raster data.`);
      return;
    }

    const layerConfig = getRasterLayerConfig(layerKey);
    const windowConfig = getLayerWindowConfig(layerConfig);
    const windowValue = windowConfig
      ? clampWindowValue(
        layerWindows[layerKey],
        windowConfig.min,
        windowConfig.max,
        windowConfig.defaultValue
      )
      : null;
    const dateWindow = windowConfig
      ? buildRecentDateWindow(windowValue)
      : {};
    const params = buildAskMapRequestParams(activeAnalysisAoi, {
      ...dateWindow,
      layer_keys: [layerKey],
      ...overrides,
    });
    const requestAoiSignature = selectedAoiSignature;
    const requestKey = buildRasterRequestKey(layerKey, params);

    setAgentRasterLoading(true);
    setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: true }));
    try {
      const result = await getAgentRasterLayers(params);
      mergeLayerData(result, {
        aoiSignature: requestAoiSignature,
        requestKey,
      });
      setWarning('');
    } catch (error) {
      setWarning(error?.message || `${moduleLabel} raster layer request failed.`);
    } finally {
      setAgentRasterLoading(false);
      setAgentLayerLoading((previous) => ({ ...previous, [`raster-${layerKey}`]: false }));
    }
  }, [
    buildRasterRequestKey,
    getRasterLayerConfig,
    layerWindows,
    mergeLayerData,
    moduleLabel,
    activeAnalysisAoi,
    selectedAoiSignature,
    setAgentLayerLoading,
    setAgentRasterLoading,
    setWarning,
  ]);

  const handleLayerWindowChange = useCallback((layerKey, nextWindow, commit = false) => {
    const layerConfig = getRasterLayerConfig(layerKey);
    const windowConfig = getLayerWindowConfig(layerConfig);
    if (!windowConfig) {
      return;
    }

    const safeWindow = clampWindowValue(
      nextWindow,
      windowConfig.min,
      windowConfig.max,
      windowConfig.defaultValue
    );
    setLayerWindows((previous) => ({
      ...previous,
      [layerKey]: safeWindow,
    }));

    if (commit && agentRasterLayerVisibility?.[layerKey]) {
      fetchRasterLayer(layerKey, buildRecentDateWindow(safeWindow));
    }
  }, [agentRasterLayerVisibility, fetchRasterLayer, getRasterLayerConfig]);

  const imageryItems = ['sentinel2', 'sentinel1'].map((type, index) => {
    const descriptor = agentImagery?.custom_range?.[type] || null;
    const orderId = `agent-${type === 'sentinel2' ? 's2' : 's1'}-custom_range`;
    const hasAoi = Boolean(activeAnalysisAoi);
    const isAvailable = Boolean(hasCurrentImageryWindow && descriptor?.tile_url);
    const loading = Boolean(
      hasAoi
      && (
        agentImageryLoading
        || agentLayerLoading?.[`base-imagery-${type}`]
        || agentLayerLoading?.[orderId]
      )
    );
    const checked = Boolean(agentShowBaseImagery && agentBaseImageryVisibility?.[type]);
    const unavailableDetail = hasAoi
      ? 'Apply the imagery window to load this layer'
      : 'Select an AOI before loading imagery';
    return {
      id: `${moduleName}-imagery-${type}`,
      orderId,
      defaultOrder: index,
      draggable: true,
      title: type === 'sentinel2' ? 'Optical Imagery' : 'SAR Imagery',
      infoKicker: `${moduleLabel} imagery`,
      infoMeta: type === 'sentinel2' ? 'COPERNICUS/S2_SR_HARMONIZED' : 'COPERNICUS/S1_GRD',
      infoText: type === 'sentinel2'
        ? 'Sentinel-2 optical mosaic filtered by the selected imagery window.'
        : 'Sentinel-1 SAR mosaic filtered by the selected imagery window.',
      subtitle: type === 'sentinel2' ? 'Sentinel-2 RGB context' : 'Sentinel-1 radar context',
      detailText: isAvailable ? 'Selected-window imagery mosaic' : unavailableDetail,
      infoDetails: [
        { label: 'Time window', value: `${resolvedImageryDateWindow.start_date} to ${resolvedImageryDateWindow.end_date}` },
        { label: 'Scope', value: activeAnalysisAoi?.label || 'No active scope' },
        { label: 'Status', value: !hasAoi ? 'Unavailable' : (loading ? 'Loading' : (isAvailable ? 'Ready' : 'Unavailable')) },
      ],
      checked,
      disabled: !hasAoi,
      loading,
      loadProgress: agentLayerProgress?.[`base-imagery-${type}`],
      showStatus: true,
      status: !hasAoi
        ? 'Unavailable: select an AOI first'
        : (loading ? 'Loading' : (isAvailable ? (checked ? 'Visible' : 'Ready') : 'Needs loading')),
      legend: {
        type: type === 'sentinel2' ? 'text' : 'palette',
        label: type === 'sentinel2' ? 'True color RGB composite' : 'VV backscatter',
        min: type === 'sentinel1' ? '-25 dB' : undefined,
        max: type === 'sentinel1' ? '0 dB' : undefined,
        palette: type === 'sentinel1' ? ['#111827', '#64748b', '#f8fafc'] : undefined,
      },
      onToggle: (event) => {
        if (!hasAoi) {
          setWarning('Please select an AOI before loading imagery.');
          return;
        }
        const nextVisible = Boolean(event?.target?.checked);
        const nextBaseVisibility = {
          ...(agentBaseImageryVisibility || {}),
          [type]: nextVisible,
        };
        setAgentSelectedType(type);
        setAgentSelectedPeriod('custom_range');
        setAgentBaseImageryVisibility(nextBaseVisibility);
        setAgentShowBaseImagery(Object.values(nextBaseVisibility).some(Boolean));
        if (nextVisible && !hasCurrentImageryWindow) {
          fetchImageryWindow();
        }
      },
    };
  });

  const rasterItems = rasterLayerConfig.map((layer, index) => {
    const descriptor = layerData?.[layer.key] || null;
    const visible = Boolean(agentRasterLayerVisibility?.[layer.key]);
    const windowConfig = getLayerWindowConfig(layer);
    const windowValue = windowConfig
      ? clampWindowValue(
        layerWindows[layer.key],
        windowConfig.min,
        windowConfig.max,
        windowConfig.defaultValue
      )
      : null;
    const expectedDateWindow = windowConfig ? buildRecentDateWindow(windowValue) : {};
    const expectedRequestKey = buildRasterRequestKey(layer.key, expectedDateWindow);
    const hasTile = Boolean(
      descriptor?.tileUrl
      && descriptor?.aoiSignature
      && descriptor.aoiSignature === selectedAoiSignature
      && descriptor?.requestKey === expectedRequestKey
    );
    const loading = Boolean(agentLayerLoading?.[`raster-${layer.key}`] || (visible && agentRasterLoading && !hasTile));
    const downloadState = rasterDownloadState[layer.key] || null;
    const disabled = Boolean(layer.unsupportedReason) || !activeAnalysisAoi;
    let status = layer.unsupportedReason
      ? `Pending: ${layer.unsupportedReason}`
      : (!activeAnalysisAoi ? 'Unavailable: select an AOI first' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Hidden'))));

    if (layer.emptyVisibleStatus && visible && hasTile) {
      status = layer.emptyVisibleStatus;
    }

    return {
      ...layer,
      id: `${moduleName}-raster-${layer.key}`,
      orderId: layer.orderId || `agent-raster-${layer.key}`,
      defaultOrder: index,
      draggable: true,
      infoKicker: `${moduleLabel} raster`,
      infoMeta: layer.dataset,
      infoDetails: [
        { label: 'Source', value: layer.dataset },
        { label: 'Scope', value: activeAnalysisAoi?.label || 'No active scope' },
        { label: 'Time window', value: windowConfig ? `${expectedDateWindow.time_start} to ${expectedDateWindow.time_end}` : 'Static layer' },
        { label: 'Status', value: status },
      ],
      infoSections: [
        {
          title: 'Function',
          text: layer.infoText,
        },
        {
          title: 'Rendering',
          rows: [
            { label: 'Layer key', value: layer.key },
            { label: 'Map layer ID', value: layer.orderId || `agent-raster-${layer.key}` },
          ],
        },
      ],
      infoWarnings: [
        layer.unsupportedReason,
        visible && !hasTile && !loading ? 'Layer is selected but tile rendering has not completed yet.' : null,
      ],
      infoActions: [
        {
          key: `download-${layer.key}`,
          label: downloadState?.status === 'preparing' ? 'Preparing GeoTIFF...' : 'Download AOI GeoTIFF',
          disabled: disabled || downloadState?.status === 'preparing',
          status: downloadState?.status,
          message: downloadState?.message,
          title: disabled
            ? 'Select an AOI before downloading this raster layer'
            : 'Download the clipped raster for the current AOI',
          onClick: () => handleAgentRasterDownload({
            layerKey: layer.key,
            title: layer.title,
            requestParams: expectedDateWindow,
          }),
        },
      ],
      checked: visible,
      disabled,
      loading,
      loadProgress: agentLayerProgress?.[`raster-${layer.key}`],
      checkboxState: disabled ? 'idle' : (loading ? 'loading' : (hasTile ? 'ready' : 'idle')),
      status,
      showStatus: true,
      sliderControl: windowConfig ? {
        label: windowConfig.label,
        value: windowValue,
        valueLabel: `${windowValue} days`,
        min: windowConfig.min,
        max: windowConfig.max,
        step: 1,
        marks: windowConfig.marks,
        disabled,
        helpText: windowConfig.helpText,
        className: 'disaster-window-control',
        ariaLabel: `${layer.title} ${windowConfig.label}`,
        onChange: (nextValue) => handleLayerWindowChange(layer.key, nextValue, false),
        onCommit: (nextValue) => handleLayerWindowChange(layer.key, nextValue, true),
      } : null,
      onToggle: (event) => {
        if (layer.unsupportedReason) {
          setWarning(layer.unsupportedReason);
          return;
        }
        if (!activeAnalysisAoi) {
          setWarning(`Please select an AOI before loading ${moduleLabel} raster data.`);
          return;
        }

        const nextVisible = Boolean(event?.target?.checked);
        setAgentRasterLayerVisibility((previous) => ({
          ...previous,
          [layer.key]: nextVisible,
        }));
        if (nextVisible && !hasTile) {
          fetchRasterLayer(layer.key);
        }
      },
    };
  });

  const vectorItems = (businessLayers || []).map((layer) => {
    const isVisible = layer.is_visible !== false;
    return {
      id: `scope-${layer.id}`,
      title: layer.label,
      subtitle: layer.source || 'business layer',
      detailText: layer.is_active ? 'Active analysis scope' : 'Stored spatial scope',
      checked: isVisible,
      disabled: false,
      status: isVisible ? 'Visible' : 'Hidden',
      legend: {
        type: 'solid',
        label: layer.is_active ? 'Active scope' : 'Spatial scope',
        color: layer.is_active ? '#1d4ed8' : '#0f766e',
      },
      onToggle: () => toggleBusinessLayerVisibility(layer.id),
      onSelect: () => activateBusinessLayerRecord(layer.id),
      actionLabel: 'Delete',
      onAction: () => deleteBusinessLayer(layer.id),
    };
  });

  const imageryTimeWindowControl = {
    label: 'Imagery window',
    valueLabel: `${resolvedImageryDateWindow.start_date} to ${resolvedImageryDateWindow.end_date}`,
    mode: 'date_range',
    disabled: false,
    fields: [
      {
        key: 'start_date',
        label: 'Start',
        type: 'date',
        value: resolvedImageryDateWindow.start_date,
        max: resolvedImageryDateWindow.end_date,
      },
      {
        key: 'end_date',
        label: 'End',
        type: 'date',
        value: resolvedImageryDateWindow.end_date,
        min: resolvedImageryDateWindow.start_date,
      },
    ],
    onChange: handleImageryDateChange,
    helpText: 'Creates Sentinel-2 and Sentinel-1 mosaics from acquisitions inside the selected inclusive window.',
    action: {
      label: agentImageryLoading ? 'Loading imagery...' : 'Apply imagery window',
      loading: agentImageryLoading,
      disabled: !activeAnalysisAoi || !hasValidImageryDateWindow || agentImageryLoading,
      onClick: fetchImageryWindow,
    },
  };

  const groups = [
    showRaster ? { key: 'raster', label: 'Raster Layers', items: rasterItems } : null,
    showImagery ? {
      key: 'imagery',
      label: 'Imagery',
      items: imageryItems,
      timeWindowControl: imageryTimeWindowControl,
    } : null,
    showVector ? {
      key: 'vector',
      label: 'Vector Layers',
      items: vectorItems,
      emptyTitle: 'No spatial scope',
      emptyText: emptyVectorText,
    } : null,
  ].filter(Boolean);

  return (
    <div className={`agent-panel-controls wildfire-panel ${panelClassName}`}>
      <section className="agent-panel-section">
        <div className="section-header agent-panel-section-header">
          <span className="section-title">Layer Manager</span>
        </div>
        <div className="agent-panel-section-body layer-manager-body">
          <LayerManager
            groups={groups}
            layerOrder={agentLayerOrder}
            setLayerOrder={setAgentLayerOrder}
          />
        </div>
      </section>

      <div className="download-btn-div">
        <button
          type="button"
          className="submit btn download disabled"
          disabled
          title={downloadTitle}
          style={{
            cursor: 'not-allowed',
            opacity: 0.5,
            pointerEvents: 'none',
          }}
        >
          DOWNLOAD GEE CODE
        </button>
      </div>
    </div>
  );
}

export default DisasterLayerPanel;
