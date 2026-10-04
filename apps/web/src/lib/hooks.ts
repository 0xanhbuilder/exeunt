import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

function sameDeps(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  return a !== null && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Runs `fn` whenever `deps` change (dropping the previous result), and on every poll tick or `reloadKey`
 * change (keeping it, so refreshes do not flicker or unmount views). Results of superseded runs are ignored.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  opts: { pollMs?: number; enabled?: boolean; reloadKey?: unknown } = {},
): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: null,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastDeps = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const changed = !sameDeps(lastDeps.current, [...deps, enabled]);
    lastDeps.current = [...deps, enabled];
    if (!enabled) {
      setState({ data: undefined, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => (changed ? { data: undefined, error: null, loading: true } : { ...s, loading: true }));
    fnRef.current().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState((s) => ({ data: changed ? undefined : s.data, error, loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, enabled, tick, opts.reloadKey]);

  useEffect(() => {
    if (!opts.pollMs || !enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the app works without it.
  }
}

/** Wall-clock seconds, refreshed every `ms`. */
export function useNowSeconds(ms = 1_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
