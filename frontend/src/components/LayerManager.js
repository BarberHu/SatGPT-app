import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Slider from 'rc-slider';

const titleCaseKey = (key) => String(key || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const formatInfoValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => formatInfoValue(entry))
      .filter(Boolean)
      .join(', ');
  }

  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entryValue]) => {
        const formatted = formatInfoValue(entryValue);
        return formatted ? `${titleCaseKey(key)}: ${formatted}` : null;
      })
      .filter(Boolean)
      .join('; ');
  }

  return String(value);
};

const normalizeInfoRows = (rows = []) => (Array.isArray(rows) ? rows : [])
  .map((row) => {
    const value = formatInfoValue(row?.value);
    if (!row?.label || !value) {
      return null;
    }
    return { label: row.label, value };
  })
  .filter(Boolean);

const buildLayerInfoPanelModel = (item) => {
  const summary = item.infoText || item.detailText || null;
  const sections = Array.isArray(item.infoSections) ? item.infoSections.filter(Boolean) : [];
  const warnings = (Array.isArray(item.infoWarnings) ? item.infoWarnings : [])
    .map(formatInfoValue)
    .filter(Boolean);
  const links = (Array.isArray(item.infoLinks) ? item.infoLinks : [])
    .filter((link) => link?.href && link?.label);
  const actions = (Array.isArray(item.infoActions) ? item.infoActions : [])
    .filter((action) => action?.label && typeof action?.onClick === 'function');

  return {
    kicker: item.infoKicker || item.badge || item.status || 'Layer',
    title: item.infoTitle || item.title,
    meta: item.infoMeta || null,
    summary,
    rows: normalizeInfoRows(item.infoDetails),
    sections,
    warnings,
    links,
    actions,
    legend: item.legend || null,
  };
};

export function LayerManagerLegend({ legendModel }) {
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

function LayerInfoPanel({ item }) {
  const panel = buildLayerInfoPanelModel(item);

  return (
    <div className="layer-info-card">
      <div className="layer-info-card-header">
        <div className="layer-info-card-kicker">{panel.kicker}</div>
        <div className="layer-info-card-title">{panel.title}</div>
        {panel.meta ? (
          <div className="layer-info-card-meta">{panel.meta}</div>
        ) : null}
      </div>

      {panel.summary ? (
        <div className="layer-info-card-summary">{panel.summary}</div>
      ) : null}

      {panel.rows.length ? (
        <div className="layer-info-card-table">
          {panel.rows.map((row) => (
            <div className="layer-info-card-row" key={`${row.label}-${row.value}`}>
              <span className="layer-info-card-key">{row.label}</span>
              <span className="layer-info-card-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {panel.legend ? (
        <div className="layer-info-card-section">
          <div className="layer-info-card-section-title">Legend</div>
          <LayerManagerLegend legendModel={panel.legend} />
        </div>
      ) : null}

      {panel.sections.map((section) => {
        const rows = normalizeInfoRows(section.rows);
        if (!rows.length && !section.text) {
          return null;
        }
        return (
          <div className="layer-info-card-section" key={section.title}>
            <div className="layer-info-card-section-title">{section.title}</div>
            {section.text ? (
              <div className="layer-info-card-section-text">{section.text}</div>
            ) : null}
            {rows.length ? (
              <div className="layer-info-card-mini-table">
                {rows.map((row) => (
                  <div className="layer-info-card-row compact" key={`${section.title}-${row.label}-${row.value}`}>
                    <span className="layer-info-card-key">{row.label}</span>
                    <span className="layer-info-card-value">{row.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {panel.warnings.length ? (
        <div className="layer-info-card-warning">
          <span className="layer-info-card-warning-label">Cautions</span>
          {panel.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      {panel.links.length || panel.actions.length ? (
        <div className="layer-info-card-actions">
          {panel.actions.map((action) => (
            <div className="layer-info-card-action-wrap" key={action.key || action.label}>
              <button
                type="button"
                className={`layer-info-card-link layer-info-card-action ${action.status ? `is-${action.status}` : ''}`}
                onClick={action.onClick}
                disabled={Boolean(action.disabled)}
                title={action.title}
              >
                {action.status === 'preparing' ? (
                  <i className="fa fa-spinner fa-spin" aria-hidden="true" />
                ) : action.status === 'success' ? (
                  <i className="fa fa-check" aria-hidden="true" />
                ) : action.status === 'error' ? (
                  <i className="fa fa-exclamation-triangle" aria-hidden="true" />
                ) : (
                  <i className="fa fa-download" aria-hidden="true" />
                )}
                <span>{action.label}</span>
              </button>
              {action.message ? (
                <div className={`layer-info-card-action-message ${action.status ? `is-${action.status}` : ''}`}>
                  {action.message}
                </div>
              ) : null}
            </div>
          ))}
          {panel.links.map((link) => (
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              key={`${link.label}-${link.href}`}
              className="layer-info-card-link"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InlineInfoTooltip({ item }) {
  const [visible, setVisible] = useState(false);
  const panel = useMemo(() => buildLayerInfoPanelModel(item), [item]);

  const openPanel = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setVisible(true);
  }, []);

  const closePanel = useCallback((event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setVisible(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible]);

  const handleTriggerKeyDown = useCallback((event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      openPanel(event);
    }
  }, [openPanel]);

  const modal = visible ? createPortal(
    <div
      className="layer-info-modal-backdrop"
      role="presentation"
      onMouseDown={closePanel}
    >
      <div
        className="layer-info-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Layer information: ${panel.title}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="layer-info-modal-close"
          aria-label="Close layer information"
          onClick={closePanel}
        >
          x
        </button>
        <LayerInfoPanel item={item} />
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span className="layer-manager-item-info-wrap">
      <span
        className="layer-manager-item-info"
        aria-label={`Layer information: ${panel.title}`}
        role="button"
        tabIndex={0}
        onClick={openPanel}
        onKeyDown={handleTriggerKeyDown}
      >
        !
      </span>
      {modal}
    </span>
  );
}

export function LayerSliderControl({ control }) {
  if (!control) {
    return null;
  }

  const isPointSelection = control.selectionMode === 'point';

  return (
    <div
      className={`layer-manager-slider-control ${isPointSelection ? 'is-point-selection' : ''} ${control.className || ''}`.trim()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="layer-manager-duration-label">
        {control.label}
        <span>{control.valueLabel}</span>
      </div>
      {control.fields?.length ? (
        <div className="layer-manager-slider-fields">
          {control.fields.map((field) => (
            <label className="layer-manager-slider-field" key={field.key}>
              <span>{field.label}</span>
              {field.type === 'select' ? (
                <select
                  value={field.value}
                  disabled={control.disabled || field.disabled}
                  onChange={(event) => control.onFieldChange?.(field.key, event.target.value)}
                  aria-label={field.ariaLabel || field.label}
                >
                  {(field.options || []).map((option) => (
                    <option key={`${field.key}-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type || 'text'}
                  value={field.value || ''}
                  min={field.min}
                  max={field.max}
                  disabled={control.disabled || field.disabled}
                  onChange={(event) => control.onFieldChange?.(field.key, event.target.value)}
                  aria-label={field.ariaLabel || field.label}
                />
              )}
            </label>
          ))}
        </div>
      ) : null}
      <div className="layer-manager-rc-slider-wrap">
        <Slider
          range={Boolean(control.range)}
          min={control.min}
          max={control.max}
          step={control.step || 1}
          marks={control.marks}
          dots={Boolean(control.dots)}
          value={control.value}
          disabled={control.disabled}
          allowCross={false}
          pushable={control.range ? (control.pushable ?? 0) : undefined}
          onChange={control.onChange}
          onChangeComplete={control.onCommit || control.onChange}
          ariaLabelForHandle={control.ariaLabel}
        />
      </div>
      {control.helpText ? (
        <div className="layer-manager-slider-help">{control.helpText}</div>
      ) : null}
    </div>
  );
}

function LayerDurationControl({ control }) {
  if (!control) {
    return null;
  }

  const percent = ((control.value - control.min) / (control.max - control.min)) * 100;

  return (
    <div className="layer-manager-duration-control" onClick={(event) => event.stopPropagation()}>
      <div className="layer-manager-duration-label">
        {control.label}
        <span>{control.valueLabel}</span>
      </div>
      <div className="layer-manager-duration-range-wrap">
        <input
          type="range"
          className="layer-manager-duration-range"
          min={control.min}
          max={control.max}
          step={control.step || 1}
          value={control.value}
          disabled={control.disabled}
          onChange={(event) => control.onChange(Number(event.target.value))}
          style={{ '--duration-progress': `${percent}%` }}
        />
      </div>
      <div className="layer-manager-duration-ticks">
        {(control.ticks || []).map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

function LayerTimeWindowControl({ control }) {
  if (!control) {
    return null;
  }

  return (
    <div className="layer-manager-time-control" onClick={(event) => event.stopPropagation()}>
      <div className="layer-manager-duration-label">
        {control.label}
        <span>{control.valueLabel}</span>
      </div>
      <div className={`layer-manager-time-fields mode-${control.mode || 'date_range'}`}>
        {(control.fields || []).map((field) => (
          <label className="layer-manager-time-field" key={field.key}>
            <span>{field.label}</span>
            {field.type === 'select' ? (
              <select
                value={field.value}
                disabled={control.disabled || field.disabled}
                onChange={(event) => control.onChange(field.key, event.target.value)}
                aria-label={field.ariaLabel || field.label}
              >
                {(field.options || []).map((option) => (
                  <option key={`${field.key}-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={field.type || 'date'}
                value={field.value || ''}
                min={field.min}
                max={field.max}
                disabled={control.disabled || field.disabled}
                onChange={(event) => control.onChange(field.key, event.target.value)}
                aria-label={field.ariaLabel || field.label}
              />
            )}
          </label>
        ))}
      </div>
      {control.helpText ? (
        <div className="layer-manager-slider-help">{control.helpText}</div>
      ) : null}
      {control.action ? (
        <button
          type="button"
          className="layer-manager-time-action"
          onClick={control.action.onClick}
          disabled={Boolean(control.action.disabled)}
        >
          {control.action.loading ? <i className="fa fa-spinner fa-spin" aria-hidden="true" /> : null}
          <span>{control.action.label}</span>
        </button>
      ) : null}
    </div>
  );
}

function LayerLoadProgress({ progress, loading }) {
  if (!progress && !loading) {
    return null;
  }

  const status = progress?.status || 'loading';
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 8));
  const requestedTiles = Number(progress?.requestedTiles) || 0;
  const settledTiles = Math.min(requestedTiles, Number(progress?.settledTiles) || 0);
  const countLabel = status === 'complete'
    ? (settledTiles > 0 ? ` · ${settledTiles} tiles rendered` : '')
    : (requestedTiles > 0 ? ` · ${settledTiles}/${requestedTiles} tiles` : '');
  const label = progress?.label || 'Preparing map layer';

  return (
    <div
      className={`layer-manager-load-progress is-${status}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(percent)}
    >
      <div className="layer-manager-load-progress-meta">
        <span>{label}{countLabel}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className="layer-manager-load-progress-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function LayerManagerItemCopy({ item }) {
  return (
    <div className="layer-manager-item-copy">
      <div className="layer-manager-item-head">
        <span className="layer-manager-item-title">{item.title}</span>
        {item.infoText ? <InlineInfoTooltip item={item} /> : null}
      </div>
      {item.subtitle ? (
        <div className="layer-manager-item-subtitle">{item.subtitle}</div>
      ) : null}
      <LayerManagerLegend legendModel={item.legend} />
      {item.detailText ? (
        <div className="layer-manager-item-detail">{item.detailText}</div>
      ) : null}
      {item.showStatus && item.status ? (
        <div className="layer-manager-item-detail">{item.status}</div>
      ) : null}
      <LayerLoadProgress progress={item.loadProgress} loading={item.loading} />
      {item.sliderControl ? <LayerSliderControl control={item.sliderControl} /> : null}
      {item.durationControl ? <LayerDurationControl control={item.durationControl} /> : null}
      {item.timeWindowControl ? <LayerTimeWindowControl control={item.timeWindowControl} /> : null}
    </div>
  );
}

const sortItemsByLayerOrder = (items = [], layerOrder = []) => {
  const orderIndex = new Map((layerOrder || []).map((layerId, index) => [layerId, index]));
  return [...items].sort((left, right) => {
    const leftIndex = orderIndex.has(left.orderId) ? orderIndex.get(left.orderId) : Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.has(right.orderId) ? orderIndex.get(right.orderId) : Number.MAX_SAFE_INTEGER;

    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return (left.defaultOrder ?? 0) - (right.defaultOrder ?? 0);
  });
};

function LayerManager({
  groups = [],
  layerOrder = [],
  setLayerOrder,
}) {
  const [draggedLayerId, setDraggedLayerId] = useState(null);
  const [dragOverState, setDragOverState] = useState({
    groupKey: null,
    targetLayerId: null,
    position: 'before',
  });

  const orderedGroups = useMemo(() => groups.map((group) => ({
    ...group,
    items: sortItemsByLayerOrder(group.items || [], layerOrder),
  })), [groups, layerOrder]);

  const handleLayerDragStart = useCallback((event, layerId) => {
    if (!layerId) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', layerId);
    setDraggedLayerId(layerId);
  }, []);

  const resolveDropPosition = useCallback((event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (event.clientY - bounds.top) >= (bounds.height / 2) ? 'after' : 'before';
  }, []);

  const handleLayerDragOver = useCallback((event, groupKey, targetLayerId) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverState({
      groupKey,
      targetLayerId,
      position: resolveDropPosition(event),
    });
  }, [resolveDropPosition]);

  const handleLayerDrop = useCallback((event, visibleOrderIds, targetLayerId) => {
    event.preventDefault();
    const sourceLayerId = event.dataTransfer.getData('text/plain') || draggedLayerId;
    const position = resolveDropPosition(event);

    if (sourceLayerId && targetLayerId && sourceLayerId !== targetLayerId && setLayerOrder) {
      setLayerOrder((previous) => {
        const visibleSet = new Set(visibleOrderIds);
        const nextVisible = visibleOrderIds.filter((layerId) => layerId !== sourceLayerId);
        const targetIndex = nextVisible.indexOf(targetLayerId);

        if (targetIndex < 0) {
          return previous;
        }

        const insertionIndex = position === 'after' ? targetIndex + 1 : targetIndex;
        nextVisible.splice(insertionIndex, 0, sourceLayerId);

        const currentOrder = Array.isArray(previous) ? previous : [];
        const firstGroupIndex = currentOrder.findIndex((layerId) => visibleSet.has(layerId));
        const remaining = currentOrder.filter((layerId) => !visibleSet.has(layerId));
        const preservedIndex = firstGroupIndex < 0
          ? remaining.length
          : Math.min(firstGroupIndex, remaining.length);
        remaining.splice(preservedIndex, 0, ...nextVisible);
        return remaining;
      });
    }

    setDraggedLayerId(null);
    setDragOverState({ groupKey: null, targetLayerId: null, position: 'before' });
  }, [draggedLayerId, resolveDropPosition, setLayerOrder]);

  const handleLayerDragEnd = useCallback(() => {
    setDraggedLayerId(null);
    setDragOverState({ groupKey: null, targetLayerId: null, position: 'before' });
  }, []);

  return (
    <div className="layer-manager-groups">
      {orderedGroups.map((group) => {
        const draggableOrderIds = group.items
          .filter((item) => item.draggable && item.orderId)
          .map((item) => item.orderId);

        return (
          <section className="layer-manager-group" key={group.key}>
            <div className="layer-manager-group-header">
              <span className="layer-manager-group-title">{group.label}</span>
            </div>
            {group.control ? <LayerSliderControl control={group.control} /> : null}
            {group.timeWindowControl ? <LayerTimeWindowControl control={group.timeWindowControl} /> : null}
            <div className="layer-manager-items">
              {group.items.length ? group.items.map((item) => {
                const isLoading = Boolean(
                  item.loading
                  || item.loadProgress?.status === 'loading'
                );
                const canReceiveDrop = Boolean(
                  setLayerOrder
                  && draggedLayerId
                  && draggableOrderIds.includes(draggedLayerId)
                  && item.draggable
                  && item.orderId
                );
                const isDragOverTarget = Boolean(
                  canReceiveDrop
                  && dragOverState.groupKey === group.key
                  && dragOverState.targetLayerId === item.orderId
                  && draggedLayerId !== item.orderId
                );

                return (
                  <div
                    key={item.id || item.key}
                    className={`layer-manager-item ${item.checked ? 'is-visible' : 'is-hidden'} ${item.disabled ? 'is-disabled' : ''} ${isLoading ? 'is-loading' : ''} ${draggedLayerId === item.orderId ? 'is-dragging' : ''} ${isDragOverTarget && dragOverState.position === 'before' ? 'is-drag-over-before' : ''} ${isDragOverTarget && dragOverState.position === 'after' ? 'is-drag-over-after' : ''}`}
                    aria-busy={isLoading}
                    onDragOver={canReceiveDrop ? (event) => handleLayerDragOver(event, group.key, item.orderId) : undefined}
                    onDrop={canReceiveDrop ? (event) => handleLayerDrop(event, draggableOrderIds, item.orderId) : undefined}
                  >
                    <div className="layer-manager-item-main">
                      <div className="layer-manager-item-checkbox-wrap">
                        <input
                          type="checkbox"
                          className={`layer-manager-checkbox ${item.checkboxState ? `is-${item.checkboxState}` : ''}`}
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
                            disabled={item.disabled}
                          >
                            <LayerManagerItemCopy item={item} />
                          </button>
                        ) : (
                          <LayerManagerItemCopy item={item} />
                        )}
                      </div>
                    </div>
                    <div className="layer-manager-item-side">
                      {item.draggable && item.orderId && setLayerOrder ? (
                        <span
                          className="layer-manager-drag-handle"
                          draggable
                          role="button"
                          tabIndex={0}
                          aria-label={`Drag to reorder ${item.title}`}
                          title="Drag to reorder layer"
                          onDragStart={(event) => handleLayerDragStart(event, item.orderId)}
                          onDragEnd={handleLayerDragEnd}
                        >
                          <i className="fa fa-bars" aria-hidden="true" />
                        </span>
                      ) : null}
                      {item.badge ? (
                        <span className="layer-manager-item-badge">{item.badge}</span>
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
                );
              }) : (
                <div className="layer-manager-item is-hidden">
                  <div className="layer-manager-item-copy">
                    <div className="layer-manager-item-title">{group.emptyTitle || 'No layers'}</div>
                    {group.emptyText ? (
                      <div className="layer-manager-item-detail">{group.emptyText}</div>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default LayerManager;
