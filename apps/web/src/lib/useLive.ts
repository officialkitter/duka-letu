import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/** Minimal reactive Dexie query hook (re-renders when underlying tables change). */
export function useLive<T>(query: () => Promise<T> | T, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (e) => console.error('liveQuery error', e),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
