import { readWorkspaceView } from './SharedMapContext';

afterEach(() => localStorage.clear());

test('the shared camera wins, retaining bearing and pitch without changing legacy storage', () => {
  const legacy = JSON.stringify({ center: [100, 15], zoom: 5 });
  localStorage.setItem('satgpt:harness:map-view:v1', legacy);
  localStorage.setItem('satgpt:map-view:v1', JSON.stringify({ center: [110, 30], zoom: 8, bearing: 42, pitch: 50 }));
  expect(readWorkspaceView()).toEqual({ center: [110, 30], zoom: 8, bearing: 42, pitch: 50 });
  expect(localStorage.getItem('satgpt:harness:map-view:v1')).toBe(legacy);
});

test('invalid shared state falls back to the old Agent camera without clearing it', () => {
  localStorage.setItem('satgpt:map-view:v1', '{invalid');
  localStorage.setItem('satgpt:harness:map-view:v1', JSON.stringify({ center: [100, 15], zoom: 5 }));
  expect(readWorkspaceView()).toEqual({ center: [100, 15], zoom: 5, bearing: 0, pitch: 0 });
  expect(localStorage.getItem('satgpt:map-view:v1')).toBe('{invalid');
});
