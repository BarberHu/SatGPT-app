export const ROAD_OUTLINE_COLOR = '#162232';

export const ROAD_LEVELS = [
  {
    id: 'major', label: 'Major roads', width: 3, outlineWidth: 4.8, color: '#ffd34d',
    classes: ['motorway', 'trunk', 'primary', 'secondary',
      'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'],
  },
  {
    id: 'secondary', label: 'Secondary roads', width: 2.2, outlineWidth: 3.8, color: '#6bdcff',
    classes: ['tertiary', 'tertiary_link'],
  },
  {
    id: 'local', label: 'Local roads', width: 1.4, outlineWidth: 2.6, color: '#eef1f4',
    classes: ['street', 'street_limited', 'service', 'track'],
  },
];

export const DEFAULT_ROAD_LEVELS = ['major'];
export const ROAD_CLASSES = ROAD_LEVELS.flatMap(level => level.classes);

export function normalizeRoadLevels(levels) {
  return Array.isArray(levels)
    ? ROAD_LEVELS.filter(level => levels.includes(level.id)).map(level => level.id)
    : DEFAULT_ROAD_LEVELS;
}
