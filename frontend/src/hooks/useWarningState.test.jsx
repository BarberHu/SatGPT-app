import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import useWarningState from './useWarningState';

describe('request-owned warnings', () => {
  let root;
  let current;
  function Harness() { current = useWarningState(); return null; }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
    act(() => root.render(<Harness />));
  });
  afterEach(() => { act(() => root.unmount()); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });
  test('clears a recovered request error', () => {
    act(() => current.setOwnedWarning('catalog:a', 'failed'));
    act(() => current.clearOwnedWarning('catalog:a'));
    expect(current.warning).toBe('');
  });
  test('preserves another failing layer even with the same error message', () => {
    act(() => current.setOwnedWarning('catalog:a', 'failed'));
    act(() => current.setOwnedWarning('catalog:b', 'failed'));
    act(() => current.clearOwnedWarning('catalog:a'));
    expect(current.warning).toBe('failed');
  });
  test('preserves a newer general warning', () => {
    act(() => current.setOwnedWarning('catalog:a', 'failed'));
    act(() => current.setWarning('another operation failed'));
    act(() => current.clearOwnedWarning('catalog:a'));
    expect(current.warning).toBe('another operation failed');
  });
});
