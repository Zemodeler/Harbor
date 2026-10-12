import { useCallback, useEffect, useRef, useState } from 'react';

/** Electron wraps main-process errors as "Error invoking remote method 'x': Error: text"; show only the text. */
export function errorText(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim() || fallback;
}

/**
 * One in-flight action with its own error text, so a failure shows next to the control that caused it
 * (the global error banner stays for everything else). Safe to unmount while the call is pending.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    setBusy(true); setError('');
    try { const value = await work(); return { ok: true, value }; }
    catch (e) { if (alive.current) setError(errorText(e)); return { ok: false }; }
    finally { if (alive.current) setBusy(false); }
  }, []);
  return { busy, error, run, clear: useCallback(() => setError(''), []) };
}
