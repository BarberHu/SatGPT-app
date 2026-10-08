import { isUsableAnalysisAoi } from './aoi';

export const hasValidFloodDates = ({ pre_date, peek_date, after_date } = {}) => {
  const dates = [pre_date, peek_date, after_date];
  return dates.every((value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }) && pre_date <= peek_date && peek_date <= after_date;
};

export const canStartFloodAnalysis = (state, aoi) => Boolean(
  state?.user_confirmed === true
  && state?.event
  && state?.location
  && hasValidFloodDates(state)
  && isUsableAnalysisAoi(aoi)
);

export const summarizeFloodImagery = (data) => {
  const descriptors = ['pre_date', 'peek_date', 'after_date', 'custom_range']
    .flatMap((period) => ['sentinel2', 'sentinel1'].map((type) => data?.[period]?.[type]));
  descriptors.push(data?.flood_detection);
  const hasTiles = descriptors.some((descriptor) => Boolean(descriptor?.tile_url));
  const errors = [...new Set([data?.error, ...descriptors.map((descriptor) => descriptor?.error)]
    .filter((error) => typeof error === 'string' && error.trim()))];
  if (hasTiles && !errors.length) return { hasTiles, warning: '' };
  const status = hasTiles ? 'Some imagery layers are unavailable.' : 'No displayable imagery was returned.';
  const detail = errors.slice(0, 3).join(' ');
  return {
    hasTiles,
    warning: `${status}${detail ? ` ${detail}` : ''} Check the layer errors or try a wider imagery window.`,
  };
};

export const hasRawToolMarkup = (text) => /<\s*[|｜]DSML[|｜]/i.test(String(text || ''));

export const UNSUPPORTED_TOOL_MESSAGE = 'This response could not start the analysis. Please retry; once the event and scope are ready, reply confirm in chat to start mapping.';
