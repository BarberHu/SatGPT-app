import React, { useMemo } from 'react';
import {
  buildCatalogLegendModel,
  buildCatalogPanelEntries,
} from '../utils/catalogLayers';

function CatalogLegendPreview({ legendModel }) {
  if (!legendModel) {
    return null;
  }

  if (legendModel.type === 'text') {
    return (
      <div className="recommended-legend-preview text-only">
        <div className="recommended-legend-meta">
          <span className="recommended-legend-label">{legendModel.label}</span>
        </div>
      </div>
    );
  }

  if (legendModel.type === 'classes') {
    return (
      <div className="recommended-legend-preview classes">
        <div className="recommended-legend-class-row">
          {legendModel.items.map((item) => (
            <div className="recommended-legend-class-chip" key={`${legendModel.label}-${item.value}`}>
              <span
                className="recommended-legend-class-color"
                style={{ backgroundColor: item.color }}
              />
              <span className="recommended-legend-class-text">{item.value}</span>
            </div>
          ))}
        </div>
        <div className="recommended-legend-meta">
          <span className="recommended-legend-range">{legendModel.label}</span>
        </div>
      </div>
    );
  }

  if (legendModel.type === 'palette') {
    return (
      <div className="recommended-legend-preview">
        <div
          className="recommended-legend-swatch gradient"
          style={{
            backgroundImage: `linear-gradient(90deg, ${legendModel.palette.join(', ')})`,
          }}
        />
        <div className="recommended-legend-meta">
          <span className="recommended-legend-label">{legendModel.label}</span>
          {(legendModel.min !== undefined && legendModel.max !== undefined) ? (
            <span className="recommended-legend-range">{legendModel.min} - {legendModel.max}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="recommended-legend-preview">
      <div
        className="recommended-legend-swatch solid"
        style={{ backgroundColor: legendModel.color }}
      />
      <div className="recommended-legend-meta">
        <span className="recommended-legend-label">{legendModel.label}</span>
      </div>
    </div>
  );
}

export function CatalogLegendInline({ descriptor, fallbackTitle }) {
  const legendModel = buildCatalogLegendModel(descriptor, fallbackTitle);

  if (!legendModel) {
    return null;
  }

  return <CatalogLegendPreview legendModel={legendModel} />;
}

export default function CatalogLayerPanel({
  layers,
  runtimeData,
  visibility,
  loading,
  onToggle,
}) {
  const groups = useMemo(
    () => buildCatalogPanelEntries({
      layers,
      runtimeData,
      visibility,
      loading,
    }),
    [layers, runtimeData, visibility, loading]
  );

  if (!groups.length) {
    return null;
  }

  return (
    <div className="recommended-layer-panel">
      <h5>Recommended Datasets</h5>
      {groups.map((group) => (
        <div className="catalog-layer-group" key={group.key}>
          <div className="catalog-layer-group-header">
            <span className="catalog-layer-group-title">{group.label}</span>
            <span className="catalog-layer-group-count">{group.items.length}</span>
          </div>
          <div className="layer-toggles">
            {group.items.map(({ layer, descriptor, visible, loading: isLoading, status }) => (
              <div className="layer-toggle-row recommended-row" key={layer.id}>
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => onToggle(layer.id)}
                  />
                  <div className="recommended-layer-copy">
                    <div className="catalog-layer-title-row">
                      <span>{layer.title}</span>
                      {layer.ui_profile?.badge_label ? (
                        <span className="catalog-layer-badge">{layer.ui_profile.badge_label}</span>
                      ) : null}
                    </div>
                    <span className="catalog-layer-summary">{layer.summary}</span>
                    {visible && descriptor?.tile_url ? (
                      <CatalogLegendInline
                        descriptor={descriptor}
                        fallbackTitle={layer.title}
                      />
                    ) : null}
                  </div>
                </label>
                {isLoading ? (
                  <span className="imagery-spinner layer-spinner" title="Loading tiles..." />
                ) : (
                  <span className={`recommended-layer-status ${status.tone}`}>{status.label}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
