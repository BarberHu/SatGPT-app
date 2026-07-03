import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Slider from 'rc-slider';
import { getAgentRasterLayers } from '../services/api';
import { buildAoiSignature, buildAskMapRequestParams } from '../utils/aoi';
import { useAppContext } from '../context/AppContext';
import 'rc-slider/assets/index.css';
import './AgentPanel.css';
import './WildfirePanel.css';

const DEFAULT_DETECTION_WINDOW = 30;
const DEFAULT_DETECTION_WINDOW_MIN = 1;
const DEFAULT_DETECTION_WINDOW_MAX = 365;
const DEFAULT_RISK_WINDOW = 60;
const DEFAULT_RISK_WINDOW_MIN = 7;
const DEFAULT_RISK_WINDOW_MAX = 365;

const IMAGERY_PERIOD_OPTIONS = [
  { value: 0, key: 'pre_date', label: 'Pre' },
  { value: 1, key: 'peek_date', label: 'Peak' },
  { value: 2, key: 'after_date', label: 'Post' },
];

const IMAGERY_PERIOD_MARKS = IMAGERY_PERIOD_OPTIONS.reduce((marks, option) => ({
  ...marks,
  [option.value]: option.label,
}), {});

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

const getImageryPeriodOption = (periodKey) => (
  IMAGERY_PERIOD_OPTIONS.find((option) => option.key === periodKey) || IMAGERY_PERIOD_OPTIONS[1]
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

function DisasterLegend({ legendModel }) {
  if (!legendModel) {
    return null;
  }

  if (legendModel.type === 'classes' && Array.isArray(legendModel.items)) {
    return (
      <div className="layer-manager-legend classes">
        <div className="layer-manager-legend-class-row">
          {legendModel.items.map((item) => (
            <span className="layer-manager-legend-class" key={`${legendModel.label}-${item.value}`}>
              <span
                className="layer-manager-legend-color"
                style={{ backgroundColor: item.color }}
              />
              <span>{item.value}</span>
            </span>
          ))}
        </div>
        <span className="layer-manager-legend-label">{legendModel.label}</span>
      </div>
    );
  }

  if (legendModel.type === 'palette' && Array.isArray(legendModel.palette)) {
    return (
      <div className="layer-manager-legend">
        <span className="layer-manager-legend-swatch gradient">
          <span
            className="layer-manager-legend-swatch-fill"
            style={{
              backgroundImage: `linear-gradient(90deg, ${legendModel.palette.join(', ')})`,
            }}
          />
        </span>
        <span className="layer-manager-legend-label">{legendModel.label}</span>
        {(legendModel.min !== undefined && legendModel.max !== undefined) ? (
          <span className="layer-manager-legend-range">{legendModel.min} - {legendModel.max}</span>
        ) : null}
      </div>
    );
  }

  if (legendModel.type === 'solid') {
    return (
      <div className="layer-manager-legend">
        <span
          className="layer-manager-legend-swatch solid"
          style={{ backgroundColor: legendModel.color }}
        />
        <span className="layer-manager-legend-label">{legendModel.label}</span>
      </div>
    );
  }

  return (
    <div className="layer-manager-legend text">
      <span className="layer-manager-legend-label">{legendModel.label}</span>
    </div>
  );
}

function DisasterLayerCopy({ item }) {
  return (
    <div className="layer-manager-item-copy">
      <div className="layer-manager-item-head">
        <span className="layer-manager-item-title">{item.title}</span>
        {item.infoText ? (
          <span className="layer-manager-item-info-wrap">
            <span
              className="layer-manager-item-info"
              title={item.infoText}
              aria-label={`Layer information: ${item.title}`}
            >
              !
            </span>
          </span>
        ) : null}
      </div>
      <div className="layer-manager-item-subtitle">{item.subtitle}</div>
      <DisasterLegend legendModel={item.legend} />
      {item.detailText ? (
        <div className="layer-manager-item-detail">{item.detailText}</div>
      ) : null}
      {item.status ? (
        <div className="layer-manager-item-detail">{item.status}</div>
      ) : null}
      {item.windowControl ? (
        <div className="layer-manager-slider-control disaster-window-control">
          <div className="layer-manager-duration-label">
            <span>{item.windowControl.label}</span>
            <span>{item.windowControl.valueLabel}</span>
          </div>
          <div className="layer-manager-rc-slider-wrap">
            <Slider
              min={item.windowControl.min}
              max={item.windowControl.max}
              step={item.windowControl.step || 1}
              marks={item.windowControl.marks}
              value={item.windowControl.value}
              disabled={item.windowControl.disabled}
              onChange={item.windowControl.onChange}
              onChangeComplete={item.windowControl.onCommit || item.windowControl.onChange}
              ariaLabelForHandle={item.windowControl.ariaLabel}
            />
          </div>
          {item.windowControl.helpText ? (
            <div className="layer-manager-slider-help">{item.windowControl.helpText}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

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
    mergeLayerData,
    setWarning,
    agentImagery,
    agentImageryLoading,
    agentSelectedPeriod,
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
  } = useAppContext();

  const [layerWindows, setLayerWindows] = useState(() => buildDefaultLayerWindows(rasterLayerConfig));
  const selectedAoiSignature = useMemo(() => buildAoiSignature(selectedAOI), [selectedAOI]);
  const imageryPeriodOption = useMemo(
    () => getImageryPeriodOption(agentSelectedPeriod),
    [agentSelectedPeriod]
  );

  const handleImageryPeriodChange = useCallback((nextValue) => {
    const numericValue = Array.isArray(nextValue) ? nextValue[0] : nextValue;
    const roundedValue = Math.round(Number(numericValue));
    const nextOption = IMAGERY_PERIOD_OPTIONS.find((option) => option.value === roundedValue) || IMAGERY_PERIOD_OPTIONS[1];
    setAgentSelectedPeriod(nextOption.key);
  }, [setAgentSelectedPeriod]);

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
    if (!selectedAOI) {
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
    const params = buildAskMapRequestParams(selectedAOI, {
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
    selectedAOI,
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

  const imageryItems = ['sentinel2', 'sentinel1'].map((type) => {
    const descriptor = agentImagery?.[agentSelectedPeriod]?.[type] || null;
    const orderId = `agent-${type === 'sentinel2' ? 's2' : 's1'}-${agentSelectedPeriod.replace('_date', '')}`;
    const hasAoi = Boolean(selectedAOI);
    const isAvailable = Boolean(descriptor?.tile_url);
    const loading = Boolean(
      hasAoi
      && (
        agentImageryLoading
        || agentLayerLoading?.[`base-imagery-${type}`]
        || agentLayerLoading?.[orderId]
      )
    );
    const checked = Boolean(agentShowBaseImagery && agentBaseImageryVisibility?.[type] && isAvailable);
    const unavailableDetail = hasAoi
      ? 'Available after imagery is loaded'
      : 'Select an AOI before loading imagery';
    return {
      id: `${moduleName}-imagery-${type}`,
      title: type === 'sentinel2' ? 'Optical Imagery' : 'SAR Imagery',
      subtitle: type === 'sentinel2' ? 'Sentinel-2 RGB context' : 'Sentinel-1 radar context',
      detailText: isAvailable ? 'Shared imagery layer' : unavailableDetail,
      checked,
      disabled: !hasAoi || !isAvailable,
      loading,
      status: !hasAoi
        ? 'Unavailable: select an AOI first'
        : (loading ? 'Loading' : (isAvailable ? (checked ? 'Visible' : 'Ready') : 'Unavailable')),
      legend: {
        type: type === 'sentinel2' ? 'text' : 'palette',
        label: type === 'sentinel2' ? 'True color RGB composite' : 'VV backscatter',
        min: type === 'sentinel1' ? '-25 dB' : undefined,
        max: type === 'sentinel1' ? '0 dB' : undefined,
        palette: type === 'sentinel1' ? ['#111827', '#64748b', '#f8fafc'] : undefined,
      },
      onToggle: (event) => {
        if (!isAvailable) return;
        const nextVisible = Boolean(event?.target?.checked);
        const nextBaseVisibility = {
          ...(agentBaseImageryVisibility || {}),
          [type]: nextVisible,
        };
        setAgentSelectedType(type);
        setAgentBaseImageryVisibility(nextBaseVisibility);
        setAgentShowBaseImagery(Object.values(nextBaseVisibility).some(Boolean));
      },
    };
  });

  const rasterItems = rasterLayerConfig.map((layer) => {
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
    const disabled = Boolean(layer.unsupportedReason) || !selectedAOI;
    let status = layer.unsupportedReason
      ? `Pending: ${layer.unsupportedReason}`
      : (!selectedAOI ? 'Unavailable: select an AOI first' : (loading ? 'Loading' : (visible ? (hasTile ? 'Visible' : 'Pending') : (hasTile ? 'Ready' : 'Hidden'))));

    if (layer.emptyVisibleStatus && visible && hasTile) {
      status = layer.emptyVisibleStatus;
    }

    return {
      ...layer,
      checked: visible,
      disabled,
      loading,
      status,
      windowControl: windowConfig ? {
        label: windowConfig.label,
        value: windowValue,
        valueLabel: `${windowValue} days`,
        min: windowConfig.min,
        max: windowConfig.max,
        step: 1,
        marks: windowConfig.marks,
        disabled,
        helpText: windowConfig.helpText,
        ariaLabel: `${layer.title} ${windowConfig.label}`,
        onChange: (nextValue) => handleLayerWindowChange(layer.key, nextValue, false),
        onCommit: (nextValue) => handleLayerWindowChange(layer.key, nextValue, true),
      } : null,
      onToggle: (event) => {
        if (layer.unsupportedReason) {
          setWarning(layer.unsupportedReason);
          return;
        }
        if (!selectedAOI) {
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

  const imageryGroupControl = {
    label: 'Imagery time',
    value: imageryPeriodOption.value,
    valueLabel: imageryPeriodOption.label,
    min: 0,
    max: 2,
    step: 1,
    marks: IMAGERY_PERIOD_MARKS,
    disabled: !selectedAOI,
    helpText: selectedAOI
      ? 'Switches the active imagery time slice without changing the shared imagery loading pipeline.'
      : 'Select an AOI before using imagery time controls.',
    ariaLabel: 'Imagery time slice',
    onChange: handleImageryPeriodChange,
  };

  const groups = [
    showRaster ? { key: 'raster', label: 'Raster Layers', items: rasterItems } : null,
    showImagery ? { key: 'imagery', label: 'Imagery', items: imageryItems, control: imageryGroupControl } : null,
    showVector ? { key: 'vector', label: 'Vector Layers', items: vectorItems } : null,
  ].filter(Boolean);

  return (
    <div className={`agent-panel-controls wildfire-panel ${panelClassName}`}>
      <section className="agent-panel-section">
        <div className="section-header agent-panel-section-header">
          <span className="section-title">Layer Manager</span>
        </div>
        <div className="agent-panel-section-body layer-manager-body">
          <div className="layer-manager-groups">
            {groups.map((group) => (
              <section className="layer-manager-group" key={group.key}>
                <div className="layer-manager-group-header">
                  <span className="layer-manager-group-title">{group.label}</span>
                </div>
                {group.control ? (
                  <div className="layer-manager-slider-control disaster-window-control">
                    <div className="layer-manager-duration-label">
                      <span>{group.control.label}</span>
                      <span>{group.control.valueLabel}</span>
                    </div>
                    <div className="layer-manager-rc-slider-wrap">
                      <Slider
                        min={group.control.min}
                        max={group.control.max}
                        step={group.control.step || 1}
                        marks={group.control.marks}
                        value={group.control.value}
                        disabled={group.control.disabled}
                        onChange={group.control.onChange}
                        onChangeComplete={group.control.onCommit || group.control.onChange}
                        ariaLabelForHandle={group.control.ariaLabel}
                        dots
                      />
                    </div>
                    {group.control.helpText ? (
                      <div className="layer-manager-slider-help">{group.control.helpText}</div>
                    ) : null}
                  </div>
                ) : null}
                <div className="layer-manager-items">
                  {group.items.length ? group.items.map((item) => (
                    <div
                      className={`layer-manager-item ${item.checked ? 'is-visible' : 'is-hidden'} ${item.disabled ? 'is-disabled' : ''}`}
                      key={item.id || item.key}
                    >
                      <div className="layer-manager-item-main">
                        <div className="layer-manager-item-checkbox-wrap">
                          <input
                            type="checkbox"
                            className="layer-manager-checkbox"
                            checked={Boolean(item.checked)}
                            onChange={item.onToggle}
                            disabled={item.disabled}
                            aria-label={`Toggle ${item.title}`}
                          />
                        </div>
                        <div className="layer-manager-item-content">
                          {item.onSelect ? (
                            <button
                              type="button"
                              className="layer-manager-item-trigger"
                              onClick={item.onSelect}
                            >
                              <DisasterLayerCopy
                                item={item}
                              />
                            </button>
                          ) : (
                            <DisasterLayerCopy
                              item={item}
                            />
                          )}
                        </div>
                      </div>
                      <div className="layer-manager-item-side">
                        {item.loading ? (
                          <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                        ) : null}
                        {item.actionLabel && item.onAction ? (
                          <button
                            type="button"
                            className="layer-manager-item-action"
                            onClick={item.onAction}
                          >
                            {item.actionLabel}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )) : (
                    <div className="layer-manager-item is-hidden">
                      <div className="layer-manager-item-copy">
                        <div className="layer-manager-item-title">No spatial scope</div>
                        <div className="layer-manager-item-detail">{emptyVectorText}</div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
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
