'use client';

import type { Reader } from '@stripe/terminal-js';
import { useEffect, useMemo, useState } from 'react';
import { buildDraft, commitDraft, type CartItem } from '../lib/checkout';
import { requestBackgroundSync, subscribeConnectivity, syncNow } from '../lib/connectivity';
import { db, getMeta } from '../lib/db';
import { formatMoney, lineTax } from '../lib/money';
import { signOut } from '../lib/supabase';
import { afterLocalCommit, subscribeSync, type SyncState } from '../lib/sync';
import {
  connectReader,
  connectedReader,
  discoverReaders,
  onReaderDisconnect,
  payByCard,
} from '../lib/terminal';
import type { Identity, Product, Tenant } from '../lib/types';
import { useLive } from '../lib/useLive';

export default function Pos({ identity, onSignedOut }: { identity: Identity; onSignedOut: () => void }) {
  const tenant = useLive(() => getMeta<Tenant>('tenant'), [], undefined);
  const currency = tenant?.currency ?? 'usd';
  const fmt = (c: number) => formatMoney(c, currency);

  const products = useLive(
    () => db.products.filter((p) => p.active && !p.deleted_at).sortBy('name'),
    [],
    [] as Product[],
  );
  const recent = useLive(() => db.sales.orderBy('occurred_at').reverse().limit(15).toArray(), [], []);
  const pending = useLive(() => db.sales.where('sync_status').equals('pending').count(), [], 0);
  const rejected = useLive(() => db.sales.where('sync_status').equals('rejected').count(), [], 0);
  const unresolvedCards = useLive(
    () => db.card_attempts.where('state').anyOf('creating', 'collecting').count(),
    [],
    0,
  );

  const [online, setOnline] = useState(true);
  const [sync, setSync] = useState<SyncState>({ phase: 'idle', lastSyncedAt: null, error: null });
  useEffect(() => subscribeConnectivity(setOnline), []);
  useEffect(() => subscribeSync(setSync), []);

  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [readers, setReaders] = useState<Reader[]>([]);
  const [reader, setReader] = useState<Reader | null>(() => connectedReader());
  useEffect(() => {
    onReaderDisconnect(() => {
      setReader(null);
      setNote({ kind: 'err', text: 'Card reader disconnected.' });
    });
    return () => onReaderDisconnect(null);
  }, []);

  const items: CartItem[] = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, quantity]) => ({ product: products.find((p) => p.id === id)!, quantity }))
        .filter((i) => i.product && i.quantity > 0),
    [cart, products],
  );

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const { product, quantity } of items) {
      const line = product.price_cents * quantity;
      subtotal += line;
      tax += lineTax(line, product.tax_rate_bps); // same function checkout.ts uses for the saved sale
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [items]);

  const shown = products.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const add = (p: Product, d: number) =>
    setCart((c) => {
      const q = Math.max(0, (c[p.id] ?? 0) + d);
      const next = { ...c, [p.id]: q };
      if (q === 0) delete next[p.id];
      return next;
    });

  async function finish(kind: 'cash' | 'card') {
    if (items.length === 0 || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const draft = await buildDraft(items, identity, currency);
      if (kind === 'cash') {
        await commitDraft(draft, [{ method: 'cash', amount_cents: draft.sale.total_cents }]);
      } else {
        await payByCard(draft);
      }
      afterLocalCommit(online);
      if (!online) void requestBackgroundSync();
      setCart({});
      setNote({
        kind: 'ok',
        text: online ? 'Sale saved.' : 'Sale saved on this device — it will sync when you are back online.',
      });
    } catch (err) {
      setNote({ kind: 'err', text: err instanceof Error ? err.message : 'Payment failed' });
    } finally {
      setBusy(false);
    }
  }

  async function findReaders() {
    setBusy(true);
    setNote(null);
    try {
      setReaders(await discoverReaders());
    } catch (err) {
      setNote({ kind: 'err', text: err instanceof Error ? err.message : 'Reader discovery failed' });
    } finally {
      setBusy(false);
    }
  }

  async function connect(r: Reader) {
    setBusy(true);
    try {
      setReader(await connectReader(r));
      setReaders([]);
    } catch (err) {
      setNote({ kind: 'err', text: err instanceof Error ? err.message : 'Could not connect' });
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    if (online) await syncNow();
    const { unsynced } = await signOut();
    if (unsynced > 0) {
      setNote({
        kind: 'err',
        text: `${unsynced} sale(s) have not synced yet. Connect to the internet and sync before signing out.`,
      });
      return;
    }
    onSignedOut();
  }

  const syncLabel =
    sync.phase === 'syncing'
      ? 'Syncing…'
      : sync.phase === 'auth'
        ? 'Sign in again to sync'
        : sync.phase === 'error'
          ? 'Sync failed — will retry'
          : sync.lastSyncedAt
            ? `Synced ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`
            : 'Not synced yet';

  const cardDisabled = busy || items.length === 0 || !online || !reader;
  const cardHint = !online ? 'Card needs a connection' : !reader ? 'Connect a reader' : '';

  return (
    <div className="pos">
      <header className="bar">
        <strong>{tenant?.name ?? 'POS'}</strong>
        <span className={`badge ${online ? 'on' : 'off'}`}>{online ? 'Online' : 'Offline'}</span>
        <span className="badge">{pending} to sync</span>
        {rejected > 0 && <span className="badge bad">{rejected} rejected</span>}
        <span className="muted">{syncLabel}</span>
        <span className="spacer" />
        <button onClick={() => void syncNow()} disabled={!online || sync.phase === 'syncing'}>
          Sync now
        </button>
        <button onClick={() => void handleSignOut()}>Sign out</button>
      </header>

      {sync.error && sync.phase !== 'idle' && <p className="banner warn">{sync.error}</p>}
      {unresolvedCards > 0 && (
        <p className="banner warn">
          {unresolvedCards} card payment(s) are unresolved. They are checked against Stripe automatically when the
          connection returns.
        </p>
      )}
      {products.length === 0 && (
        <p className="banner">
          {online ? 'Loading catalog…' : 'No catalog on this device yet — connect to the internet once to download it.'}
        </p>
      )}

      <div className="layout">
        <section className="catalog">
          <input
            className="search"
            placeholder="Search products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="grid">
            {shown.map((p) => (
              <button key={p.id} className="tile" onClick={() => add(p, 1)}>
                <span>{p.name}</span>
                <b>{fmt(p.price_cents)}</b>
              </button>
            ))}
          </div>
        </section>

        <aside className="cart">
          <h2>Current sale</h2>
          {items.length === 0 && <p className="muted">Tap a product to add it.</p>}
          <ul>
            {items.map(({ product, quantity }) => (
              <li key={product.id}>
                <span className="grow">{product.name}</span>
                <button aria-label={`Remove one ${product.name}`} onClick={() => add(product, -1)}>−</button>
                <span className="qty">{quantity}</span>
                <button aria-label={`Add one ${product.name}`} onClick={() => add(product, 1)}>+</button>
                <span className="amt">{fmt(product.price_cents * quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="totals">
            <dt>Subtotal</dt><dd>{fmt(totals.subtotal)}</dd>
            <dt>Tax</dt><dd>{fmt(totals.tax)}</dd>
            <dt className="total">Total</dt><dd className="total">{fmt(totals.total)}</dd>
          </dl>

          <div className="pay">
            <button className="primary" disabled={busy || items.length === 0} onClick={() => void finish('cash')}>
              Cash
            </button>
            <button className="primary" disabled={cardDisabled} onClick={() => void finish('card')} title={cardHint}>
              Card
            </button>
          </div>
          {cardHint && items.length > 0 && <p className="muted small">{cardHint}</p>}
          {note && <p className={note.kind === 'ok' ? 'ok' : 'error'} role="status">{note.text}</p>}

          <div className="reader">
            <h3>Card reader</h3>
            {reader ? (
              <p>Connected: <b>{reader.label ?? reader.id}</b></p>
            ) : (
              <>
                <button onClick={() => void findReaders()} disabled={busy || !online}>Find readers</button>
                {!online && <p className="muted small">Needs a connection.</p>}
                <ul>
                  {readers.map((r) => (
                    <li key={r.id}>
                      <span className="grow">{r.label ?? r.id}</span>
                      <button onClick={() => void connect(r)} disabled={busy}>Connect</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>

      <section className="recent">
        <h2>Recent sales</h2>
        <ul>
          {recent.map((s) => (
            <li key={s.id}>
              <span>{new Date(s.occurred_at).toLocaleTimeString()}</span>
              <b>{formatMoney(s.total_cents, s.currency)}</b>
              <span className={`badge ${s.sync_status === 'synced' ? 'on' : s.sync_status === 'rejected' ? 'bad' : ''}`}>
                {s.sync_status}
              </span>
              {s.sync_reason && <span className="muted small">{s.sync_reason}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
