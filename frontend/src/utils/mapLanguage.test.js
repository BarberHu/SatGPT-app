import { applyEnglishMapLabels } from './mapLanguage';

test('English basemap labels preserve formatting, non-name fields, and native-name fallback', () => {
  const field = ['format', ['get', 'name_zh-Hans'], {}, '\n', {}, ['get', 'ref'], {}];
  const layers = [
    { id: 'places', type: 'symbol', layout: { 'text-field': field } },
    { id: 'roads', type: 'symbol', layout: { 'text-field': '{name} ({ref})' } },
    { id: 'elevation', type: 'symbol', layout: { 'text-field': ['get', 'ele'] } },
  ];
  const map = { getStyle: () => ({ layers }), setLayoutProperty: vi.fn((id, key, value) => {
    layers.find(layer => layer.id === id).layout[key] = value;
  }) };
  applyEnglishMapLabels(map);
  expect(layers[0].layout['text-field']).toEqual(['format', ['coalesce', ['get', 'name_en'], ['get', 'name']], {}, '\n', {}, ['get', 'ref'], {}]);
  expect(layers[1].layout['text-field']).toEqual(['concat', ['coalesce', ['get', 'name_en'], ['get', 'name']], ' (', ['get', 'ref'], ')']);
  expect(layers[2].layout['text-field']).toEqual(['get', 'ele']);
  applyEnglishMapLabels(map);
  expect(map.setLayoutProperty).toHaveBeenCalledTimes(2);
});
