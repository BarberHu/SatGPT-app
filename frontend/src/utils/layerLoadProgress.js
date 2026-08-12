export const TILE_PROGRESS_START = 8;
export const TILE_PROGRESS_FLOOR = 12;
export const TILE_PROGRESS_CEILING = 96;

const toFiniteNumber = (value) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

export const buildTileEventKey = (event) => {
  const coord = event?.coord || event?.tile?.tileID || null;
  const canonical = coord?.canonical || coord || null;

  if (!canonical) {
    return null;
  }

  const zoom = toFiniteNumber(canonical.z ?? coord?.overscaledZ);
  const x = toFiniteNumber(canonical.x);
  const y = toFiniteNumber(canonical.y);

  if (zoom === null || x === null || y === null) {
    return null;
  }

  const wrap = toFiniteNumber(coord?.wrap) ?? 0;
  return `${zoom}/${x}/${y}@${wrap}`;
};

export const calculateTileLoadPercent = ({
  requestedTiles = 0,
  settledTiles = 0,
  previousPercent = TILE_PROGRESS_START,
  complete = false,
} = {}) => {
  if (complete) {
    return 100;
  }

  const safePrevious = Math.max(
    TILE_PROGRESS_START,
    Math.min(TILE_PROGRESS_CEILING, Number(previousPercent) || TILE_PROGRESS_START)
  );
  const safeRequested = Math.max(0, Number(requestedTiles) || 0);
  const safeSettled = Math.max(0, Math.min(safeRequested, Number(settledTiles) || 0));

  if (!safeRequested) {
    return safePrevious;
  }

  const measuredPercent = TILE_PROGRESS_FLOOR + Math.round(
    (safeSettled / safeRequested) * (TILE_PROGRESS_CEILING - TILE_PROGRESS_FLOOR)
  );

  // New viewport tiles can join an in-flight load and increase the denominator.
  // Keep the UI monotonic so the progress bar never appears to move backwards.
  return Math.max(safePrevious, Math.min(TILE_PROGRESS_CEILING, measuredPercent));
};
