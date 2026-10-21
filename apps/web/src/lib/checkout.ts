import { db, getDeviceId } from './db';
import { lineTax } from './money';
import type { DraftSale, Identity, Payment, Product } from './types';

export interface CartItem {
  product: Product;
  quantity: number;
}

/** Pure: build the immutable sale + lines from a cart. Totals are integer cents. */
export async function buildDraft(
  cart: CartItem[],
  identity: Identity,
  currency: string,
): Promise<DraftSale> {
  const saleId = crypto.randomUUID();
  let subtotal = 0;
  let tax = 0;

  const lines = cart.map(({ product, quantity }) => {
    const lineTotal = product.price_cents * quantity;
    const lineTaxCents = lineTax(lineTotal, product.tax_rate_bps);
    subtotal += lineTotal;
    tax += lineTaxCents;
    return {
      id: crypto.randomUUID(),
      sale_id: saleId,
      product_id: product.id,
      name: product.name, // snapshot: later catalog edits never rewrite history
      quantity,
      unit_price_cents: product.price_cents,
      tax_cents: lineTaxCents,
      line_total_cents: lineTotal,
    };
  });

  return {
    sale: {
      id: saleId,
      device_id: await getDeviceId(),
      cashier_id: identity.userId,
      status: 'completed',
      currency: currency.toLowerCase(),
      subtotal_cents: subtotal,
      tax_cents: tax,
      total_cents: subtotal + tax,
      occurred_at: new Date().toISOString(),
    },
    lines,
  };
}

export interface PaymentDraft {
  method: 'cash' | 'card';
  amount_cents: number;
  stripe_payment_intent_id?: string | null;
}

/**
 * Atomically persist the finished sale into the outbox. Once this transaction
 * commits, the sale is durable on the device and will be pushed on the next
 * connectivity transition. Optionally flips a card attempt to 'succeeded' in the
 * same transaction so there is never a charged-but-unrecorded window.
 */
export async function commitDraft(draft: DraftSale, payments: PaymentDraft[]): Promise<void> {
  const paid = payments.reduce((n, p) => n + p.amount_cents, 0);
  if (paid !== draft.sale.total_cents) throw new Error('Payments must equal the sale total');

  const rows: Payment[] = payments.map((p) => ({
    id: crypto.randomUUID(),
    sale_id: draft.sale.id,
    method: p.method,
    amount_cents: p.amount_cents,
    stripe_payment_intent_id: p.stripe_payment_intent_id ?? null,
  }));

  await db.transaction('rw', [db.sales, db.sale_lines, db.payments, db.card_attempts], async () => {
    // Idempotent: reconciliation may try to commit a sale that already landed.
    if (await db.sales.get(draft.sale.id)) return;
    await db.sales.add({ ...draft.sale, sync_status: 'pending', sync_reason: null });
    await db.sale_lines.bulkAdd(draft.lines);
    await db.payments.bulkAdd(rows);
    const attempt = await db.card_attempts.get(draft.sale.id);
    if (attempt) await db.card_attempts.update(draft.sale.id, { state: 'succeeded' });
  });
}
