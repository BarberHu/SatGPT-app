import { finalizeLatestRequest } from './latestRequest';

describe('finalizeLatestRequest', () => {
  test('stops loading and keeps a successful request key for deduplication', () => {
    const requestKeyRef = { current: 'request-1' };
    const setLoading = vi.fn();

    expect(finalizeLatestRequest({
      requestKeyRef,
      requestKey: 'request-1',
      setLoading,
    })).toBe(true);

    expect(setLoading).toHaveBeenCalledWith(false);
    expect(requestKeyRef.current).toBe('request-1');
  });

  test('stops loading before releasing a failed request key for retry', () => {
    const requestKeyRef = { current: 'request-1' };
    const loadingUpdates = [true];

    expect(finalizeLatestRequest({
      requestKeyRef,
      requestKey: 'request-1',
      setLoading: (value) => loadingUpdates.push(value),
      releaseForRetry: true,
    })).toBe(true);

    expect(loadingUpdates).toEqual([true, false]);
    expect(requestKeyRef.current).toBeNull();
  });

  test('does not let an older request clear the current loading state', () => {
    const requestKeyRef = { current: 'request-2' };
    const setLoading = vi.fn();

    expect(finalizeLatestRequest({
      requestKeyRef,
      requestKey: 'request-1',
      setLoading,
      releaseForRetry: true,
    })).toBe(false);

    expect(setLoading).not.toHaveBeenCalled();
    expect(requestKeyRef.current).toBe('request-2');
  });
});
