import { MapboxAdapter } from './mapboxAdapter';
import { MapService } from './mapService';

vi.mock('mapbox-gl', async () => {
  const { FakeMap } = await import('./tests/fakeMap');
  class Popup {
    once(event, callback) { this.onClose = callback; }
    setLngLat() { return this; }
    setDOMContent(node) { this.node = node; node.className = 'test-popup'; return this; }
    addTo(map) { map.getContainer().append(this.node); return this; }
    remove() { this.node.remove(); this.onClose(); }
  }
  return { default: { Map: FakeMap, NavigationControl: class {}, Popup } };
});

const url = `/api/harness/conversations/webgis-${'a'.repeat(32)}/tasks/${'b'.repeat(32)}/osm/${'c'.repeat(32)}.geojson`;
const point = { x: 10, y: 10 };
const click = { point, lngLat: { lng: 10, lat: 20 } };
const shapes = [
  ['roads', 'line', 'LineString', 14, 'line', 'Unnamed road'],
  ['pois', 'circle', 'Point', 16, 'point', 'Unnamed point of interest'],
  ['buildings', 'fill', 'Polygon', 16, 'point', 'Unnamed building'],
];

let engine, map, service, scope, hit, stacking, popup;
const physical = (id, group = 'agent:one') => `satgpt-layer-${service.physical(group, id)}`;
const label = id => `${physical(id)}:label`;

beforeEach(() => {
  engine = new MapboxAdapter(document.createElement('div'), { token: 'pk.test', style: 'mapbox://styles/test' });
  map = engine.map;
  service = new MapService(engine);
  service.setMode('agent');
  service.selectConversation('one');
  scope = service.scope('agent:one');
  hit = new Map();
  stacking = [];
  vi.spyOn(map, 'queryRenderedFeatures').mockImplementation((_point, { layers }) => (
    stacking.filter(id => layers.includes(id) && hit.has(id)).map(id => ({ layer: map.getLayer(id), properties: hit.get(id) }))
  ));
  popup = () => map.getContainer().querySelector('.test-popup');
  for (const [id, renderAs] of shapes) scope.addLayer({ id, renderAs, kind: 'geojson', data_url: url });
});

afterEach(() => service.dispose());

test.each(shapes)('%s picks its geometry and labels only named features from the same source',
  (id, renderAs, geometry, minzoom, placement, unnamed) => {
    const target = physical(id);
    hit.set(target, { name: '  ', category: 'example', osm_type: 'way', osm_id: 245 });
    stacking = [target];
    map.fire('mousemove', click);
    expect(map.getCanvas().style.cursor).toBe('pointer');
    map.fire('click', click);
    expect(popup().querySelector('strong').textContent).toBe(unnamed);
    expect([...popup().querySelectorAll('div')].map(row => row.textContent)).toEqual([
      'Category: example', 'OSM type: way', 'OSM ID: 245',
    ]);
    map.fire('mouseout');
    expect(map.getCanvas().style.cursor).toBe('');
    hit.get(target).name = '<img src=x>';
    map.fire('click', click);
    expect(popup().querySelector('strong').textContent).toBe('<img src=x>');
    expect(popup().querySelector('img')).toBeNull();
    expect(map.getLayer(target)).toMatchObject({ type: renderAs, filter: ['==', ['geometry-type'], geometry] });
    expect(map.getLayer(label(id))).toMatchObject({
      type: 'symbol', source: map.getLayer(target).source, minzoom,
      filter: ['all', ['==', ['geometry-type'], geometry], ['!=', ['string', ['get', 'name'], ''], '']],
      layout: { 'symbol-placement': placement, 'text-field': ['get', 'name'], 'text-allow-overlap': false },
    });
    map.fire('styledata');
    expect(map.getLayoutProperty(label(id), 'text-field')).toEqual(['get', 'name']);
  });

test('uses Mapbox paint order and excludes hidden, transparent, and out-of-session layers', () => {
  for (const [id] of shapes) hit.set(physical(id), { name: id });
  const other = service.scope('agent:two');
  other.addLayer({ id: 'roads', renderAs: 'line', kind: 'geojson', data_url: url });
  const otherRoad = physical('roads', 'agent:two');
  hit.set(otherRoad, { name: 'other road' });
  stacking = [otherRoad, physical('pois'), physical('buildings'), physical('roads')];
  map.fire('click', click);
  expect(popup().textContent).toContain('pois');
  scope.setVisibility('pois', false);
  expect(popup()).toBeNull();
  expect(map.getLayoutProperty(label('pois'), 'visibility')).toBe('none');
  map.fire('click', click);
  expect(popup().textContent).toContain('buildings');
  scope.setOpacity('buildings', 0);
  expect(popup()).toBeNull();
  expect(map.getPaintProperty(label('buildings'), 'text-opacity')).toBe(0);
  map.fire('click', click);
  expect(popup().textContent).toContain('roads');
  service.selectConversation('two');
  expect(popup()).toBeNull();
  map.fire('click', click);
  expect(popup().textContent).toContain('other road');
  service.setMode('basic');
  expect(popup()).toBeNull();
  map.queryRenderedFeatures.mockClear();
  map.fire('click', click);
  expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
});

test('shows annotated raster metrics and distinguishes a valid zero from missing data', () => {
  const poi = physical('pois');
  const building = physical('buildings');
  hit.set(poi, { name: 'Hospital', coverage: 'complete', sample_value: 0 });
  hit.set(building, { coverage: 'partial', flood_area_m2: 21.25, observed_area_m2: 42.5 });
  stacking = [poi];
  map.fire('click', click);
  expect(popup().textContent).toContain('Raster value: 0');
  hit.set(poi, { name: 'Hospital', coverage: 'none' });
  map.fire('click', click);
  expect(popup().textContent).toContain('Raster coverage: No data');
  expect(popup().textContent).toContain('Raster value: —');
  stacking = [building];
  map.fire('click', click);
  expect(popup().textContent).toContain('Raster coverage: Partial');
  expect(popup().textContent).toContain('Flood overlap: 21.25 m²');
  expect(popup().textContent).toContain('Observed area: 42.5 m²');
  expect(map.getPaintProperty(building, 'fill-color')).toEqual([
    'match', ['get', 'analysis_status'], 'hit', '#c53d24', 'no_data', '#757575', '#d58620',
  ]);
});

test('draws Agent OSM roads red and highlights inundated segments with a wider yellow stroke', () => {
  const road = physical('roads');
  expect(map.getPaintProperty(road, 'line-color')).toEqual([
    'match', ['get', 'analysis_status'], 'hit', '#FFEA00', 'no_data', '#757575', '#EF3338',
  ]);
  expect(map.getPaintProperty(road, 'line-width')).toEqual(['match', ['get', 'analysis_status'], 'hit', 4, 3]);
});

test('moves labels with geometry, restores them after a style change and cleans up on removal and teardown', () => {
  const move = vi.spyOn(map, 'moveLayer');
  scope.setOrder(['roads', 'pois', 'buildings']);
  expect(move.mock.calls.map(([id]) => id)).toEqual([
    physical('buildings'), label('buildings'), physical('pois'), label('pois'), physical('roads'), label('roads'),
  ]);
  hit.set(physical('roads'), { name: 'Road' });
  stacking = [physical('roads')];
  scope.setVisibility('pois', false);
  map.fire('click', click);
  map.layers.clear();
  map.sources.clear();
  map.fire('style.load');
  expect(popup()).toBeNull();
  expect(map.getLayoutProperty(label('pois'), 'visibility')).toBe('none');
  expect(map.getLayer(label('roads')).source).toBe(map.getLayer(physical('roads')).source);
  scope.replaceLayer('roads', { kind: 'geojson', data_url: url, reload_version: 1 });
  expect(map.events.filter(event => event.event === 'click')).toHaveLength(1);
  map.fire('click', click);
  expect(popup()).not.toBeNull();
  scope.removeLayer('roads');
  expect(popup()).toBeNull();
  expect(map.getLayer(label('roads'))).toBeUndefined();
  expect(map.getLayer(physical('roads'))).toBeUndefined();
  const unbind = vi.spyOn(map, 'off');
  service.dispose();
  expect(unbind.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining(['click', 'mousemove', 'touchend']));
});

test('adding the same layer again removes its old map source and popup once', () => {
  const id = physical('pois');
  hit.set(id, { name: 'Hospital' });
  stacking = [id];
  map.fire('click', click);
  expect(popup()).not.toBeNull();
  const remove = vi.spyOn(engine, 'removeLayer');
  scope.addLayer({ id: 'pois', renderAs: 'circle', kind: 'geojson', data_url: url });
  expect(remove).toHaveBeenCalledExactlyOnceWith(service.physical('agent:one', 'pois'));
  expect(popup()).toBeNull();
  expect(map.getLayer(label('pois')).source).toBe(map.getLayer(id).source);
  map.fire('click', click);
  expect(popup().textContent).toContain('Hospital');
});

test('handles a tap suppressed by Draw, ignores touch drags, and leaves clicks to Draw during editing', async () => {
  hit.set(physical('pois'), { name: 'Hospital' });
  stacking = [physical('pois')];
  const touch = { ...click, points: [click.point], originalEvent: { defaultPrevented: false } };
  const draw = vi.fn(event => { event.originalEvent.defaultPrevented = true; });
  map.on('touchend', draw);
  map.fire('touchstart', touch);
  map.fire('touchmove', { ...touch, point: { x: 40, y: 40 } });
  map.fire('touchend', touch);
  await Promise.resolve();
  expect(popup()).toBeNull();
  map.fire('touchstart', touch);
  map.fire('touchend', touch);
  await Promise.resolve();
  expect(popup().textContent).toContain('Hospital');
  service.setOsmPickingSuspended(true);
  expect(popup()).toBeNull();
  const drawClick = vi.fn();
  map.on('click', drawClick);
  map.queryRenderedFeatures.mockClear();
  map.fire('click', touch);
  expect(drawClick).toHaveBeenCalledTimes(1);
  expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
  service.setOsmPickingSuspended(false);
  map.fire('click', click);
  expect(popup().textContent).toContain('Hospital');
});
