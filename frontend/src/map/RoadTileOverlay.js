import { ROAD_LEVELS, ROAD_OUTLINE_COLOR } from './roadLevels';
import { GridTileOverlay, projectGridPoint, validPoint } from './GridTileOverlay';

const LEVEL_BY_CLASS = new Map(ROAD_LEVELS.flatMap(level => level.classes.map(value => [value, level.id])));
const PAINT_ORDER = [...ROAD_LEVELS].reverse();

function addLine(ctx, map, points, longitude) {
  let penDown = false;
  for (const coordinate of points) {
    const point = projectGridPoint(map, coordinate, longitude);
    if (!validPoint(point)) {
      penDown = false;
      continue;
    }
    if (penDown) ctx.lineTo(point.x, point.y);
    else ctx.moveTo(point.x, point.y);
    penDown = true;
  }
}

/** Shows the loaded Mapbox road tiles through the selected grid's screen mask. */
export class RoadTileOverlay extends GridTileOverlay {
  constructor(map, { levels, ...options }) {
    super(map, { ...options, canvasClass: 'road-tiles-canvas' });
    this.levels = levels;
    this.refresh();
  }

  get isVisible() { return this.visible && this.levels.length > 0; }
  setLevels(levels) { this.levels = levels; this.refresh(); }

  paintFeatures(ctx, features, longitude) {
    const lines = new Map(this.levels.map(level => [level, []]));
    for (const feature of features) {
      const bucket = lines.get(LEVEL_BY_CLASS.get(feature.properties?.class));
      if (!bucket) continue;
      const { geometry } = feature;
      if (!geometry) continue;
      if (geometry.type === 'LineString') bucket.push(geometry.coordinates);
      if (geometry.type === 'MultiLineString') bucket.push(...geometry.coordinates);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const level of PAINT_ORDER) {
      const bucket = lines.get(level.id);
      if (!bucket?.length) continue;
      ctx.beginPath();
      for (const points of bucket) addLine(ctx, this.map, points, longitude);
      ctx.strokeStyle = ROAD_OUTLINE_COLOR;
      ctx.lineWidth = level.outlineWidth;
      ctx.stroke();
      ctx.strokeStyle = level.color;
      ctx.lineWidth = level.width;
      ctx.stroke();
    }
  }
}
