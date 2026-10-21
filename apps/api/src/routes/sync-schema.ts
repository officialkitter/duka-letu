import { z } from 'zod';

const uuid = z.string().uuid();
const cents = z.number().int().min(0).max(100_000_000);

const LineIn = z.object({
  id: uuid,
  product_id: uuid.nullable(),
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(10_000),
  unit_price_cents: cents,
  tax_cents: cents,
  line_total_cents: cents,
});

const PaymentIn = z.object({
  id: uuid,
  method: z.enum(['cash', 'card']),
  amount_cents: cents.refine((n) => n > 0, 'amount must be positive'),
  stripe_payment_intent_id: z.string().startsWith('pi_').max(255).nullish(),
});

export const SaleIn = z.object({
  id: uuid,
  currency: z.string().length(3),
  subtotal_cents: cents,
  tax_cents: cents,
  total_cents: cents,
  occurred_at: z.string().datetime({ offset: true }),
  lines: z.array(LineIn).min(1).max(200),
  payments: z.array(PaymentIn).min(1).max(10),
});
export type SaleInput = z.infer<typeof SaleIn>;

export const PULL_TABLES = ['products', 'sales', 'sale_lines', 'payments'] as const;
export type PullTable = (typeof PULL_TABLES)[number];

export const BodySchema = z.object({
  deviceId: z.string().min(1).max(100),
  sales: z.array(SaleIn).max(100).default([]),
  pull: z.object({
    cursors: z.record(z.string(), z.string().datetime({ offset: true }).nullable()).default({}),
    overlapSeconds: z.number().int().min(0).max(300).default(0),
    limit: z.number().int().min(1).max(1000).default(500),
  }),
});

export type SaleResult = {
  id: string;
  status: 'accepted' | 'duplicate' | 'rejected' | 'retry';
  reason?: string;
};

/** Pure arithmetic/integrity checks that need no I/O. Returns a reason or null. */
export function validateSale(s: SaleInput): string | null {
  let subtotal = 0;
  let tax = 0;
  for (const l of s.lines) {
    if (l.line_total_cents !== l.quantity * l.unit_price_cents) return 'line_total_mismatch';
    subtotal += l.line_total_cents;
    tax += l.tax_cents;
  }
  if (subtotal !== s.subtotal_cents) return 'subtotal_mismatch';
  if (tax !== s.tax_cents) return 'tax_mismatch';
  if (s.subtotal_cents + s.tax_cents !== s.total_cents) return 'total_mismatch';

  const paid = s.payments.reduce((n, p) => n + p.amount_cents, 0);
  if (paid !== s.total_cents) return 'payment_total_mismatch';

  for (const p of s.payments) {
    if (p.method === 'card' && !p.stripe_payment_intent_id) return 'card_missing_payment_intent';
    if (p.method === 'cash' && p.stripe_payment_intent_id) return 'cash_with_payment_intent';
  }
  return null;
}
