import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useBusinessLayerPersistence from './useBusinessLayerPersistence';
import { buildBusinessLayerRevision } from '../repositories/businessLayerRepository';

function HookHarness({ options }) {
  useBusinessLayerPersistence(options);
  return null;
}

describe('useBusinessLayerPersistence', () => {
  let container;
  let root;
  let repository;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
    repository = { save: jest.fn().mockResolvedValue({ success: true }) };
  });

  afterEach(() => {
    act(() => root.unmount());
    jest.useRealTimers();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('does not write while the initial IndexedDB read is unresolved or failed', () => {
    act(() => {
      root.render(<HookHarness options={{
        namespace: 'session-1',
        records: [],
        ready: false,
        repository,
      }} />);
      jest.runAllTimers();
    });

    expect(repository.save).not.toHaveBeenCalled();
  });

  test('coalesces rapid layer changes into the latest write', async () => {
    const base = {
      namespace: 'session-1',
      ready: true,
      debounceMs: 100,
      repository,
    };
    act(() => root.render(<HookHarness options={{ ...base, records: [{ id: 'one' }] }} />));
    act(() => root.render(<HookHarness options={{ ...base, records: [{ id: 'one' }, { id: 'two' }] }} />));
    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save.mock.calls[0][1]).toEqual([{ id: 'one' }, { id: 'two' }]);
  });

  test('revision ignores timestamps but changes with geometry', () => {
    const first = buildBusinessLayerRevision([{
      id: 'one',
      updated_at: '2024-01-01',
      geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
    }]);
    const timestampOnly = buildBusinessLayerRevision([{
      id: 'one',
      updated_at: '2025-01-01',
      geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
    }]);
    const geometryChanged = buildBusinessLayerRevision([{
      id: 'one',
      updated_at: '2025-01-01',
      geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] } },
    }]);

    expect(timestampOnly).toBe(first);
    expect(geometryChanged).not.toBe(first);
  });
});
