import { afterEach, expect, test } from 'vitest';
import {
  latestLayerBounds, messageLayerBounds,
} from './viewState';
import { chatViewModel } from '../chatViewModel';

test('focuses only validated explicit layer bounds', () => {
  const valid = { layers: [{ name: 'Water', bounds: [100, 10, 110, 20] }] };
  const invalid = { layers: [{ name: 'Rain', bounds: [200, 10, 210, 20] }] };
  expect(messageLayerBounds(valid, valid.layers[0])).toEqual([100, 10, 110, 20]);
  expect(messageLayerBounds(invalid, invalid.layers[0])).toBeNull();
  expect(latestLayerBounds([invalid, valid])).toEqual([100, 10, 110, 20]);
});

test('keeps each result layer locator independent', () => {
  const layers = [
    { name: 'Zhengzhou flood', bounds: [113.45, 34.3, 114.2, 35] },
    { name: 'Southern flood strip', bounds: [113.45, 33.3, 114.2, 34.45] },
  ];
  const message = { id: 'answer', role: 'assistant', job_id: 'job', content: 'Done', layers };
  expect(messageLayerBounds(message, layers[0])).toEqual([113.45, 34.3, 114.2, 35]);
  expect(messageLayerBounds(message, layers[1])).toEqual([113.45, 33.3, 114.2, 34.45]);
  expect(latestLayerBounds([message])).toEqual([113.45, 33.3, 114.2, 34.45]);
  expect(chatViewModel([message], null, null).items[0].layers.map(layer => layer.bounds)).toEqual([
    [113.45, 34.3, 114.2, 35], [113.45, 33.3, 114.2, 34.45],
  ]);
});
