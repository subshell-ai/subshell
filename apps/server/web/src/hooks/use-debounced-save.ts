import { useCallback, useEffect, useRef } from "react";

/** Return value of {@link useDebouncedSave}. */
export interface DebouncedSave<T> {
  /** Records a new value and (re)starts the debounce timer. */
  schedule: (value: T) => void;
  /** Persists the latest scheduled value immediately, bypassing the timer. No-op if nothing is pending. */
  flush: () => void;
}

/**
 * Debounces a save function: `schedule` records the latest value and resets
 * a `delayMs` timer, so a burst of calls (a drag, a pan) collapses into one
 * network request after the burst ends. Local state is always the source of
 * truth in the meantime — this hook only decides when to persist it.
 *
 * The pending save also flushes immediately on unmount and when the tab
 * becomes hidden (`visibilitychange`), so navigating away or closing the tab
 * never strands the latest change unsaved.
 *
 * If the debounce timer fires while a previous save is still in flight, that
 * in-flight request is aborted rather than left to race the new one — the
 * new payload is always the complete, latest state, so nothing is lost by
 * dropping the older request.
 *
 * A save that fails is reported through `onError` rather than only logged.
 * This hook owns the whole persisted state of whatever uses it, and a save
 * failing is invisible in the UI otherwise — every tile keeps responding
 * normally and the arrangement silently reverts on the next reload.
 *
 * @param save - Persists one value; receives an `AbortSignal` to pass through to `fetch`
 * @param delayMs - Debounce window in milliseconds
 * @param onError - Called with any non-abort failure, so the caller can surface it
 */
export function useDebouncedSave<T>(
  save: (value: T, signal: AbortSignal) => Promise<unknown>,
  delayMs: number,
  onError?: (err: unknown) => void,
): DebouncedSave<T> {
  const pendingValueRef = useRef<T | undefined>(undefined);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  // Lets flush/schedule always call the latest `save` without needing it in
  // their own dependency arrays (callers often pass a fresh closure per
  // render).
  const saveRef = useRef(save);
  saveRef.current = save;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    const value = pendingValueRef.current as T;
    void saveRef.current(value, controller.signal).catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("Debounced save failed", err);
      onErrorRef.current?.(err);
    });
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pendingValueRef.current = value;
      dirtyRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, delayMs);
    },
    [flush, delayMs],
  );

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") flush();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flush();
    };
  }, [flush]);

  return { schedule, flush };
}
