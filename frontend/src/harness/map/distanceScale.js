/** Find a round metric distance and its actual projected pixel width. */
export function distanceScale(measure, maxWidth) {
  if (!Number.isFinite(maxWidth) || maxWidth < 40) return null;
  const maxMeters = measure(maxWidth);
  if (!Number.isFinite(maxMeters) || maxMeters <= 0) return null;
  const exponent = 10 ** Math.floor(Math.log10(maxMeters));
  const leading = maxMeters / exponent;
  const meters = (leading >= 5 ? 5 : leading >= 2 ? 2 : 1) * exponent;
  let low = 0, high = maxWidth;
  for (let i = 0; i < 14; i++) {
    const middle = (low + high) / 2;
    const value = measure(middle);
    if (!Number.isFinite(value) || value < 0) return null;
    if (value < meters) low = middle; else high = middle;
  }
  const unit = meters >= 1000 ? '公里' : '米';
  const divisor = meters >= 1000 ? 1000 : 1;
  const format = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 6 });
  return { meters, width: (low + high) / 2, unit,
    ticks: [0, 0.25, 0.5, 1].map(fraction => ({ fraction, label: format.format(meters * fraction / divisor) })) };
}
