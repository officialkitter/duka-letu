import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { requireAuth } from '../auth.js';
import { withTenant } from '../db.js';
import { stripe } from '../stripe.js';
import {
  BodySchema,
  PULL_TABLES,
  validateSale,
  type PullTable,
  type SaleInput,
  type SaleResult,
} from './sync-schema.js';

/* -------------------------------------------------------------------------
 * Wire format
 *
 *   POST /v1/sync
 *   {
 *     deviceId,
 *     sales:   [ ...outbox sales, each with lines[] and payments[] ],
 *     pull:    { cursors: {table: isoTs|null}, overlapSeconds, limit }
 *   }
 *   -> {
 *     results: [{ id, status: accepted|duplicate|rejected|retry, reason? }],
 *     pull:    { table: { rows, cursor, hasMore } }
 *   }
 *
 * "Push" is idempotent (client-generated UUIDs + ON CONFLICT DO NOTHING), so a
 * dropped response is safe to retry. "Pull" uses a server-stamped cursor per
 * table plus a small overlap window on the first page to tolerate commits that
 * land out of timestamp order; the client upserts by id so overlap is harmless.
 * ----------------------------------------------------------------------- */

// Column lists are a fixed allow-list; table names are never user-controlled.
const PULL_COLUMNS: Record<PullTable, string> = {
  products: 'id, sku, name, price_cents, tax_rate_bps, active, deleted_at',
  sales:
    'id, device_id, cashier_id, status, currency, subtotal_cents, tax_cents, total_cents, occurred_at',
  sale_lines:
    'id, sale_id, product_id, name, quantity, unit_price_cents, tax_cents, line_total_cents',
  payments: 'id, sale_id, method, amount_cents, stripe_payment_intent_id',
};

// Microsecond-precision ISO string so the cursor round-trips without loss.
const SYNC_TS = `to_char(server_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Verdict = { ok: true } | { ok: false; retry: boolean; reason: string };

/**
 * Card payments are never trusted from the device. Each PaymentIntent is
 * re-read from Stripe and must be succeeded, for the exact amount, and tagged
 * with this tenant and this sale. Network trouble => retry (keep in outbox),
 * a definite mismatch => reject (surface to a manager).
 */
async function verifyCards(sale: SaleInput, tenantId: string): Promise<Verdict> {
  for (const p of sale.payments) {
    if (p.method !== 'card') continue;
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id!);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return { ok: false, retry: false, reason: 'unknown_payment_intent' };
      return { ok: false, retry: true, reason: 'stripe_unavailable' };
    }
    if (pi.status === 'processing') return { ok: false, retry: true, reason: 'payment_processing' };
    if (pi.status !== 'succeeded') return { ok: false, retry: false, reason: 'payment_not_succeeded' };
    if (pi.amount_received !== p.amount_cents) return { ok: false, retry: false, reason: 'amount_mismatch' };
    if (pi.currency !== sale.currency.toLowerCase()) return { ok: false, retry: false, reason: 'currency_mismatch' };
    if (pi.metadata?.['tenant_id'] !== tenantId || pi.metadata?.['sale_id'] !== sale.id) {
      return { ok: false, retry: false, reason: 'payment_metadata_mismatch' };
    }
  }
  return { ok: true };
}

async function insertSale(
  c: PoolClient,
  deviceId: string,
  s: SaleInput,
): Promise<SaleResult> {
  await c.query('savepoint sale_sp');
  try {
    const ins = await c.query(
      `insert into public.sales
         (id, tenant_id, device_id, cashier_id, status, currency,
          subtotal_cents, tax_cents, total_cents, occurred_at)
       values ($1, app.tenant_id(), $2, app.user_id(), 'completed', $3, $4, $5, $6, $7)
       on conflict (id) do nothing
       returning id`,
      [s.id, deviceId, s.currency.toLowerCase(), s.subtotal_cents, s.tax_cents, s.total_cents, s.occurred_at],
    );

    if (ins.rowCount === 0) {
      // Either a retry of an already-synced sale (visible to us) or a collision
      // with another tenant's row (invisible under RLS).
      const seen = await c.query('select 1 from public.sales where id = $1', [s.id]);
      await c.query('release savepoint sale_sp');
      return seen.rowCount ? { id: s.id, status: 'duplicate' } : { id: s.id, status: 'rejected', reason: 'id_conflict' };
    }

    await c.query(
      `insert into public.sale_lines
         (id, tenant_id, sale_id, product_id, name, quantity, unit_price_cents, tax_cents, line_total_cents)
       select x.id, app.tenant_id(), $1::uuid, x.product_id, x.name, x.quantity,
              x.unit_price_cents, x.tax_cents, x.line_total_cents
       from jsonb_to_recordset($2::jsonb) as x(
         id uuid, product_id uuid, name text, quantity int,
         unit_price_cents int, tax_cents int, line_total_cents int)
       on conflict (id) do nothing`,
      [s.id, JSON.stringify(s.lines)],
    );

    await c.query(
      `insert into public.payments
         (id, tenant_id, sale_id, method, amount_cents, stripe_payment_intent_id)
       select x.id, app.tenant_id(), $1::uuid, x.method::public.payment_method,
              x.amount_cents, x.stripe_payment_intent_id
       from jsonb_to_recordset($2::jsonb) as x(
         id uuid, method text, amount_cents int, stripe_payment_intent_id text)
       on conflict (id) do nothing`,
      [s.id, JSON.stringify(s.payments)],
    );

    await c.query('release savepoint sale_sp');
    return { id: s.id, status: 'accepted' };
  } catch (err) {
    await c.query('rollback to savepoint sale_sp');
    const code = (err as { code?: string }).code ?? '';
    // Integrity (23xxx) and RLS/privilege (42501) failures are permanent for this
    // payload: reject it so the device stops retrying and a manager can review.
    if (code.startsWith('23') || code === '42501') {
      return { id: s.id, status: 'rejected', reason: `db_${code}` };
    }
    throw err; // transient: fail the whole request, client retries the batch
  }
}

async function pullTable(
  c: PoolClient,
  table: PullTable,
  cursor: string | null,
  overlapSeconds: number,
  limit: number,
) {
  const since = cursor ?? '1970-01-01T00:00:00Z';
  const { rows } = await c.query(
    `select ${PULL_COLUMNS[table]}, ${SYNC_TS} as sync_ts
       from public.${table}
      where tenant_id = app.tenant_id()
        and server_updated_at > ($1::timestamptz - make_interval(secs => $2::int))
      order by server_updated_at asc
      limit $3`,
    [since, cursor ? overlapSeconds : 0, limit],
  );
  const last = rows[rows.length - 1] as { sync_ts: string } | undefined;
  return { rows, cursor: last?.sync_ts ?? cursor, hasMore: rows.length === limit };
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/sync', { preHandler: requireAuth, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 10) });
    }
    const { deviceId, sales, pull } = parsed.data;
    const claims = req.claims;

    // 1) I/O-free validation, then 2) Stripe verification — both BEFORE we hold
    //    a DB transaction open.
    const verdicts = new Map<string, SaleResult>();
    const toInsert: SaleInput[] = [];
    for (const s of sales) {
      const bad = validateSale(s);
      if (bad) {
        verdicts.set(s.id, { id: s.id, status: 'rejected', reason: bad });
        continue;
      }
      const v = await verifyCards(s, claims.tenant_id);
      if (!v.ok) {
        verdicts.set(s.id, { id: s.id, status: v.retry ? 'retry' : 'rejected', reason: v.reason });
        continue;
      }
      toInsert.push(s);
    }

    // 3) One transaction under the caller's RLS identity: push, then pull.
    const out = await withTenant(claims, async (c) => {
      const tenant = await c.query<{ currency: string }>(
        'select currency from public.tenants where id = app.tenant_id()',
      );
      const tenantCurrency = tenant.rows[0]?.currency.trim().toLowerCase();

      for (const s of toInsert) {
        if (tenantCurrency && s.currency.toLowerCase() !== tenantCurrency) {
          verdicts.set(s.id, { id: s.id, status: 'rejected', reason: 'tenant_currency_mismatch' });
          continue;
        }
        verdicts.set(s.id, await insertSale(c, deviceId, s));
      }

      const pulled: Record<string, Awaited<ReturnType<typeof pullTable>>> = {};
      for (const t of PULL_TABLES) {
        pulled[t] = await pullTable(c, t, pull.cursors[t] ?? null, pull.overlapSeconds, pull.limit);
      }
      const t = await c.query<{ id: string; name: string; currency: string }>(
        'select id, name, currency from public.tenants where id = app.tenant_id()',
      );
      return { pulled, tenant: t.rows[0] ? { ...t.rows[0], currency: t.rows[0].currency.trim() } : null };
    });

    return {
      results: sales.map((s) => verdicts.get(s.id)!),
      pull: out.pulled,
      tenant: out.tenant,
    };
  });
}
