import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { env } from '../env.js';
import { stripe } from '../stripe.js';

/**
 * Stripe Terminal server-side half. The browser uses ONLY the Stripe Terminal
 * JS SDK for readers/cards; the three things the SDK needs a backend for are:
 *   - a short-lived connection token,
 *   - a card_present PaymentIntent created with the platform secret key,
 *   - cancellation of an abandoned intent.
 * All require a verified tenant-scoped session. These endpoints are inherently
 * online-only (Stripe has to be reachable to take a card).
 */

const CreateIntent = z.object({
  saleId: z.string().uuid(),
  amount_cents: z.number().int().min(50).max(100_000_000),
  currency: z.string().length(3),
});

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/terminal/config', { preHandler: requireAuth }, async () => ({
    locationId: env.STRIPE_TERMINAL_LOCATION_ID ?? null,
  }));

  app.post('/v1/terminal/connection-token', { preHandler: requireAuth }, async () => {
    const token = await stripe.terminal.connectionTokens.create();
    return { secret: token.secret };
  });

  app.post('/v1/terminal/payment-intents', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreateIntent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { saleId, amount_cents, currency } = parsed.data;
    const { tenant_id, sub } = req.claims;

    // The tenant and sale ids are stamped into metadata; /v1/sync later refuses
    // to accept a PaymentIntent whose metadata does not match the pushing tenant.
    const pi = await stripe.paymentIntents.create(
      {
        amount: amount_cents,
        currency: currency.toLowerCase(),
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata: { tenant_id, sale_id: saleId, cashier_id: sub },
      },
      // Retrying the same sale+amount returns the same intent instead of a new one.
      { idempotencyKey: `pi_${tenant_id}_${saleId}_${amount_cents}` },
    );
    return { id: pi.id, client_secret: pi.client_secret };
  });

  // Used by the device to reconcile a card attempt whose outcome it never saw
  // (tab closed / crash between "card charged" and "sale saved locally").
  app.get('/v1/terminal/payment-intents/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const pi = await stripe.paymentIntents.retrieve(id);
    if (pi.metadata?.['tenant_id'] !== req.claims.tenant_id) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { id: pi.id, status: pi.status, amount_received: pi.amount_received, currency: pi.currency };
  });

  app.post('/v1/terminal/payment-intents/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const pi = await stripe.paymentIntents.retrieve(id);
    if (pi.metadata?.['tenant_id'] !== req.claims.tenant_id) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (pi.status === 'succeeded') return reply.code(409).send({ error: 'already_succeeded' });
    await stripe.paymentIntents.cancel(id);
    return { ok: true };
  });
}
