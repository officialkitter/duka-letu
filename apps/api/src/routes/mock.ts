import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { MOCK_PRODUCTS, MOCK_TENANT } from '../mock/seed.js';
import { BodySchema, PULL_TABLES, validateSale, type PullTable, type SaleResult } from './sync-schema.js';

type Row = Record<string, unknown> & { id: string; sync_ts: string };

const tables: Record<PullTable, Row[]> = {
  products: MOCK_PRODUCTS.map((p) => ({ ...p })),
  sales: [],
  sale_lines: [],
  payments: [],
};

// Strictly increasing so cursors never skip or repeat rows.
let lastTs = Date.now();
const nextTs = () => new Date((lastTs = Math.max(lastTs + 1, Date.now()))).toISOString();

const intents = new Map<string, { amount: number; currency: string; status: string }>();

const CreateIntent = z.object({
  saleId: z.string().uuid(),
  amount_cents: z.number().int().min(50).max(100_000_000),
  currency: z.string().length(3),
});

/** In-memory stand-in for /v1/sync and /v1/terminal/*, used when MOCK_MODE=true. */
export async function mockRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/sync', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { deviceId, sales, pull } = parsed.data;
    const { sub } = req.claims;

    const results: SaleResult[] = [];
    for (const s of sales) {
      const bad = validateSale(s);
      if (bad) {
        results.push({ id: s.id, status: 'rejected', reason: bad });
        continue;
      }
      if (tables.sales.some((r) => r.id === s.id)) {
        results.push({ id: s.id, status: 'duplicate' });
        continue;
      }
      const ts = nextTs();
      tables.sales.push({
        id: s.id,
        device_id: deviceId,
        cashier_id: sub,
        status: 'completed',
        currency: s.currency.toLowerCase(),
        subtotal_cents: s.subtotal_cents,
        tax_cents: s.tax_cents,
        total_cents: s.total_cents,
        occurred_at: s.occurred_at,
        sync_ts: ts,
      });
      for (const l of s.lines) tables.sale_lines.push({ ...l, sale_id: s.id, sync_ts: ts });
      for (const p of s.payments) {
        tables.payments.push({ ...p, stripe_payment_intent_id: p.stripe_payment_intent_id ?? null, sale_id: s.id, sync_ts: ts });
      }
      results.push({ id: s.id, status: 'accepted' });
    }

    const out: Record<string, { rows: Row[]; cursor: string | null; hasMore: boolean }> = {};
    for (const t of PULL_TABLES) {
      const cursor = pull.cursors[t] ?? null;
      const after = tables[t].filter((r) => cursor === null || r.sync_ts > cursor);
      const rows = after.slice(0, pull.limit);
      out[t] = {
        rows,
        cursor: rows.length ? rows[rows.length - 1]!.sync_ts : cursor,
        hasMore: after.length > rows.length,
      };
    }
    return { results, pull: out, tenant: MOCK_TENANT };
  });

  app.get('/v1/terminal/config', { preHandler: requireAuth }, async () => ({ locationId: 'tml_mock' }));

  app.post('/v1/terminal/connection-token', { preHandler: requireAuth }, async () => ({
    secret: `pst_mock_${randomBytes(8).toString('hex')}`,
  }));

  app.post('/v1/terminal/payment-intents', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreateIntent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const id = `pi_mock${randomBytes(8).toString('hex')}`;
    intents.set(id, { amount: parsed.data.amount_cents, currency: parsed.data.currency.toLowerCase(), status: 'requires_payment_method' });
    return { id, client_secret: `${id}_secret_mock` };
  });

  app.get('/v1/terminal/payment-intents/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const pi = intents.get(id);
    if (!pi) return reply.code(404).send({ error: 'not_found' });
    return { id, status: 'succeeded', amount_received: pi.amount, currency: pi.currency };
  });

  app.post('/v1/terminal/payment-intents/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!intents.delete(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
