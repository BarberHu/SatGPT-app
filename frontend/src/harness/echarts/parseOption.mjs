import { parseEChartsOption } from './vendor/option.ts';
import { DEFAULT_CONFIG } from './vendor/protocol.ts';

// Models often use HTML line breaks from ECharts examples. Canvas rich-text
// tooltips need real newlines; retain the upstream restriction against HTML.
function normalizeTooltips(value) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'tooltip') {
      for (const tooltip of Array.isArray(child) ? child : [child]) {
        if (tooltip && typeof tooltip.formatter === 'string') {
          tooltip.formatter = tooltip.formatter.replace(/<br\s*\/?\s*>/gi, '\n');
        }
      }
    }
    normalizeTooltips(child);
  }
}

export function parseChartOption(source) {
  const option = parseEChartsOption(source, DEFAULT_CONFIG);
  normalizeTooltips(option);
  return option;
}
