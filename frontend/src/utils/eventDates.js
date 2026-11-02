export function getEventDateError({ pre_date: pre, peek_date: peak, after_date: after } = {}) {
  const dates = [pre, peak, after];
  if (dates.some((value) => !value)) return 'Pre-flood, peak, and post-flood dates are required.';
  const isValid = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!dates.every(isValid)) return 'Enter valid event dates in YYYY-MM-DD format.';
  if (pre > peak || peak > after) return 'Event dates must follow: pre-flood ≤ peak ≤ post-flood.';
  return null;
}
