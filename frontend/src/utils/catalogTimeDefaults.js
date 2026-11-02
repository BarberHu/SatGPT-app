const clampInteger = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
};

const parseDateParts = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    return null;
  }

  return { year, month };
};

const firstParsedDate = (...values) => (
  values.map(parseDateParts).find(Boolean) || null
);

export const resolveDefaultCatalogPointSelection = ({
  peakDate,
  startDate,
  endDate,
  minYear,
  maxYear,
}) => {
  const eventAnchor = firstParsedDate(peakDate, startDate, endDate);
  if (!eventAnchor) {
    return { year: minYear, month: 1 };
  }

  return {
    year: clampInteger(eventAnchor.year, minYear, maxYear, maxYear),
    month: clampInteger(eventAnchor.month, 1, 12, 12),
  };
};

export const resolveDefaultCatalogYearRange = ({
  startDate,
  peakDate,
  endDate,
  minYear,
  maxYear,
}) => {
  const startAnchor = firstParsedDate(startDate, peakDate, endDate);
  const endAnchor = firstParsedDate(endDate, peakDate, startDate);
  const startYear = clampInteger(startAnchor?.year, minYear, maxYear, minYear);
  const endYear = clampInteger(endAnchor?.year, minYear, maxYear, startYear);

  return [startYear, Math.max(startYear, endYear)];
};

export const resolveDefaultCatalogHistoryRange = ({ minYear, maxYear }) => [
  minYear,
  maxYear,
];
