import { reconcileCardAttempts } from './terminal';
import { runSync } from './sync';

/**
 * Connectivity state machine. Sync is triggered ONLY by a change in observed
 * state (unknown -> online at launch, offline -> online later). There is no
 * polling timer and no per-sale trigger (see SYNC_POLICY in sync.ts).
 *
 * navigator.onLine can say "online" behind a captive portal; that is fine here:
 * the sync request simply fails, the outbox is untouched, and the next real
 * transition (or the manual "Sync now" button) tries again.
 */
type Listener = (online: boolean) => void;

let current: boolean | null = null;
const listeners = new Set<Listener>();
let started = false;

export function isOnline(): boolean {
  return current ?? (typeof navigator !== 'undefined' ? navigator.onLine : false);
}

export function subscribeConnectivity(l: Listener): () => void {
  listeners.add(l);
  if (current !== null) l(current);
  return () => listeners.delete(l);
}

function observe(online: boolean) {
  if (current === online) return; // not a state change
  const previous = current;
  current = online;
  listeners.forEach((l) => l(online));
  if (online) void flush(previous === null ? 'startup' : 'reconnected');
}

async function flush(reason: string) {
  try {
    await reconcileCardAttempts(); // settle any charged-but-unrecorded card sales first
  } catch {
    /* reconcile is best-effort; the sync below must still run */
  }
  await runSync(reason);
}

/** Manual escape hatch (user pressed "Sync now"). Not a poll. */
export function syncNow(): Promise<void> {
  return flush('manual');
}

export function startConnectivity(): () => void {
  if (started) return () => undefined;
  started = true;

  const onOnline = () => observe(true);
  const onOffline = () => observe(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  // Service worker relays Chromium's Background Sync to open tabs.
  const onMessage = (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === 'RUN_SYNC') void flush('background-sync');
  };
  navigator.serviceWorker?.addEventListener('message', onMessage);

  observe(navigator.onLine); // first observed state counts as a transition

  return () => {
    started = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    navigator.serviceWorker?.removeEventListener('message', onMessage);
  };
}

/** Ask the browser to wake us when connectivity returns (Chromium only; harmless elsewhere). */
export async function requestBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as unknown as { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync;
    await sync?.register('pos-sync');
  } catch {
    /* unsupported or denied: the launch/online-event triggers still cover it */
  }
}
