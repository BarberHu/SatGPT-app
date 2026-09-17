import { useEffect, useRef } from 'react';
import businessLayerRepository, {
  buildBusinessLayerRevision,
} from '../repositories/businessLayerRepository';

export default function useBusinessLayerPersistence({
  namespace,
  records,
  ready,
  debounceMs = 250,
  repository = businessLayerRepository,
  onError,
}) {
  const lastPersistedRevisionRef = useRef(null);
  const activeControllerRef = useRef(null);

  useEffect(() => {
    lastPersistedRevisionRef.current = null;
  }, [namespace]);

  useEffect(() => {
    if (!ready || !namespace) {
      return undefined;
    }

    const revision = buildBusinessLayerRevision(records);
    if (revision === lastPersistedRevisionRef.current) {
      return undefined;
    }

    const controller = new AbortController();
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        await repository.save(namespace, records, { signal: controller.signal });
        if (!controller.signal.aborted) {
          lastPersistedRevisionRef.current = revision;
        }
      } catch (error) {
        if (!controller.signal.aborted && !error?.isCanceled) {
          onError?.(error);
        }
      } finally {
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null;
      }
    };
  }, [debounceMs, namespace, onError, ready, records, repository]);

  useEffect(() => () => {
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);
}
