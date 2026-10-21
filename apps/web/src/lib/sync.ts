import { api, ApiError, type SyncResponse, type SyncSaleIn } from './api';
import { db, getDeviceId, getMeta, setMeta } from './db';
import type { LocalSale } from './types';

/**
 * Sync policy.
 *
 * The product requirement is a pull-and-push batch sync that runs ONLY when a
 * connectivity state change is detected (offline -> online, or the first state
 * observed at launch). `flushOnLocalWriteWhileOnline` is the single switch for
 * the one place that policy hurts: a sale rung up while already online would
 * otherwise sit in the outbox until the next transition. Leave false to match
 * the spec exactly; set true if you want sales pushed as they happen.
 */
export const SYNC_POLICY = {
  flushOnLocalWriteWhileOnline: false,
  pushBatchSize: 50,
  pullPageSize: 500,
  /** Re-read this much history on the first pull page to tolerate out-of-order commits. */
  firstPageOverlapSeconds: 30,
} as const;

export type SyncPhase = 'idle' | 'syncing' | 'error' | 'auth';

export interface SyncState {
  phase: SyncPhase;
  lastSyncedAt: string | null;
  error: string | null;
}

let state: SyncState = { phase: 'idle', lastSyncedAt: null, error: null };
const listeners = new Set<(s: SyncState) => void>();

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function subscribeSync(l: (s: SyncState) => void): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

const TABLES = ['products', 'sales', 'sale_lines', 'payments'] as const;
type Cursors = Record<(typeof TABLES)[number], string | null>;

let running = false;
let rerun = false;

/** Single-flight: concurrent triggers coalesce into at most one follow-up run. */
export async function runSync(reason: string): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  setState({ phase: 'syncing', error: null });
  try {
    await doSync(reason);
    setState({ phase: 'idle', lastSyncedAt: new Date().toISOString(), error: null });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setState({ phase: 'auth', error: 'Please sign in again to sync.' });
    } else {
      // Network failures land here. Nothing is lost: the outbox is untouched and
      // the next connectivity transition (or "Sync now") retries.
      setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      void runSync('coalesced');
    }
  }
}

async function loadOutbox(exclude: Set<string>, limit: number): Promise<SyncSaleIn[]> {
  const pending = await db.sales.where('sync_status').equals('pending').toArray();
  const picked = pending.filter((s) => !exclude.has(s.id)).slice(0, limit);
  const out: SyncSaleIn[] = [];
  for (const s of picked) {
    const [lines, payments] = await Promise.all([
      db.sale_lines.where('sale_id').equals(s.id).toArray(),
      db.payments.where('sale_id').equals(s.id).toArray(),
    ]);
    out.push({
      id: s.id,
      currency: s.currency,
      subtotal_cents: s.subtotal_cents,
      tax_cents: s.tax_cents,
      total_cents: s.total_cents,
      occurred_at: s.occurred_at,
      lines: lines.map(({ sale_id: _s, ...l }) => l),
      payments: payments.map(({ sale_id: _s, ...p }) => p),
    });
  }
  return out;
}

async function doSync(_reason: string): Promise<void> {
  const deviceId = await getDeviceId();
  const attempted = new Set<string>(); // never resend a 'retry' sale within one run
  let first = true;

  for (;;) {
    const batch = await loadOutbox(attempted, SYNC_POLICY.pushBatchSize);
    batch.forEach((s) => attempted.add(s.id));

    const cursors = (await getMeta<Cursors>('cursors')) ?? emptyCursors();
    const res = await api.sync({
      deviceId,
      sales: batch,
      pull: {
        cursors,
        overlapSeconds: first ? SYNC_POLICY.firstPageOverlapSeconds : 0,
        limit: SYNC_POLICY.pullPageSize,
      },
    });
    first = false;

    await applyResponse(res, cursors);

    const more = TABLES.some((t) => res.pull[t].hasMore);
    const morePending = (await loadOutbox(attempted, 1)).length > 0;
    if (!more && !morePending) break;
  }
}

function emptyCursors(): Cursors {
  return { products: null, sales: null, sale_lines: null, payments: null };
}

async function applyResponse(res: SyncResponse, prev: Cursors): Promise<void> {
  const strip = <T extends { sync_ts: string }>(rows: T[]) =>
    rows.map(({ sync_ts: _ts, ...rest }) => rest);

  await db.transaction('rw', [db.products, db.sales, db.sale_lines, db.payments, db.meta], async () => {
    // 1) Outcome of what we pushed.
    for (const r of res.results) {
      if (r.status === 'accepted' || r.status === 'duplicate') {
        await db.sales.update(r.id, { sync_status: 'synced', sync_reason: null });
      } else if (r.status === 'rejected') {
        await db.sales.update(r.id, { sync_status: 'rejected', sync_reason: r.reason ?? 'rejected' });
      } else {
        await db.sales.update(r.id, { sync_reason: r.reason ?? 'retry' }); // stays pending
      }
    }

    // 2) Server changes. Upsert by id, so the overlap window is harmless.
    await db.products.bulkPut(strip(res.pull.products.rows));

    const sales: LocalSale[] = strip(res.pull.sales.rows).map((s) => ({
      ...s,
      sync_status: 'synced',
      sync_reason: null,
    }));
    await db.sales.bulkPut(sales);
    await db.sale_lines.bulkPut(strip(res.pull.sale_lines.rows));
    await db.payments.bulkPut(strip(res.pull.payments.rows));

    // 3) Persist cursors only in the same transaction as the data they describe.
    const next: Cursors = {
      products: res.pull.products.cursor ?? prev.products,
      sales: res.pull.sales.cursor ?? prev.sales,
      sale_lines: res.pull.sale_lines.cursor ?? prev.sale_lines,
      payments: res.pull.payments.cursor ?? prev.payments,
    };
    await setMeta('cursors', next);
    if (res.tenant) await setMeta('tenant', res.tenant);
  });
}

/** Called after a sale is committed locally. No-op under the strict policy. */
export function afterLocalCommit(isOnline: boolean): void {
  if (SYNC_POLICY.flushOnLocalWriteWhileOnline && isOnline) void runSync('local-write');
}
