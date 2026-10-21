import type { Reader, Terminal } from '@stripe/terminal-js';
import { api } from './api';
import { db } from './db';
import { commitDraft } from './checkout';
import { MOCK_MODE } from './mock';
import type { DraftSale } from './types';

let mockReader: Reader | null = null;
const FAKE_READER = { id: 'tmr_mock', label: 'Demo reader (simulated)', device_type: 'simulated' } as unknown as Reader;

/**
 * ALL card and reader interaction goes through the Stripe Terminal JavaScript
 * SDK. There are no vendor drivers, native bridges or local hardware code.
 *
 * Constraint worth knowing: the JS SDK talks to internet-connected readers
 * (e.g. BBPOS WisePOS E, Stripe Reader S700) via Stripe's cloud, and Stripe
 * Terminal's offline mode exists only in the iOS/Android SDKs. So a card can
 * only be taken while the device has connectivity; offline, the register takes
 * cash and queues the sale. Card UI is disabled when offline (see Pos.tsx).
 */

let terminal: Terminal | null = null;
let unexpectedDisconnectHandler: (() => void) | null = null;

export function onReaderDisconnect(h: (() => void) | null) {
  unexpectedDisconnectHandler = h;
}

/** Lazy: the SDK script is fetched from js.stripe.com only when a card is first needed. */
async function getTerminal(): Promise<Terminal> {
  if (terminal) return terminal;
  const { loadStripeTerminal } = await import('@stripe/terminal-js');
  const StripeTerminal = await loadStripeTerminal();
  if (!StripeTerminal) throw new Error('Could not load Stripe Terminal (are you online?)');
  terminal = StripeTerminal.create({
    onFetchConnectionToken: async () => (await api.connectionToken()).secret,
    onUnexpectedReaderDisconnect: () => unexpectedDisconnectHandler?.(),
  });
  return terminal;
}

export async function discoverReaders(): Promise<Reader[]> {
  if (MOCK_MODE) return [FAKE_READER];
  const t = await getTerminal();
  const simulated = process.env.NEXT_PUBLIC_STRIPE_SIMULATED === 'true';
  const cfg = await api.terminalConfig();
  const result = await t.discoverReaders(
    simulated ? { simulated: true } : { location: cfg.locationId ?? undefined },
  );
  if ('error' in result) throw new Error(result.error.message);
  return result.discoveredReaders;
}

export async function connectReader(reader: Reader): Promise<Reader> {
  if (MOCK_MODE) return (mockReader = reader);
  const t = await getTerminal();
  const result = await t.connectReader(reader);
  if ('error' in result) throw new Error(result.error.message);
  return result.reader;
}

export async function disconnectReader(): Promise<void> {
  mockReader = null;
  if (terminal) await terminal.disconnectReader();
}

export function connectedReader(): Reader | null {
  if (MOCK_MODE) return mockReader;
  if (terminal?.getConnectionStatus() !== 'connected') return null;
  return (terminal as unknown as { connectedReader(): Reader | null }).connectedReader() ?? null;
}

/**
 * Take a card payment for `draft` and, on success, commit the sale locally.
 *
 *   1. Persist a CardAttempt first (crash-safety; see reconcileCardAttempts).
 *   2. Server creates the card_present PaymentIntent (tenant + sale in metadata).
 *   3. SDK: collectPaymentMethod -> processPayment (customer taps/inserts).
 *   4. Atomically save sale + payment (+ mark attempt succeeded).
 */
export async function payByCard(draft: DraftSale): Promise<void> {
  if (MOCK_MODE) {
    const { id: saleId, total_cents: amount, currency } = draft.sale;
    const intent = await api.createIntent({ saleId, amount_cents: amount, currency });
    await new Promise((r) => setTimeout(r, 1800)); // simulated tap + authorisation
    await commitDraft(draft, [
      { method: 'card', amount_cents: amount, stripe_payment_intent_id: intent.id },
    ]);
    return;
  }
  const t = await getTerminal();
  const { id: saleId, total_cents: amount, currency } = draft.sale;

  await db.card_attempts.put({
    sale_id: saleId,
    payment_intent_id: null,
    amount_cents: amount,
    state: 'creating',
    draft,
    created_at: new Date().toISOString(),
  });

  let piId: string | null = null;
  try {
    const intent = await api.createIntent({ saleId, amount_cents: amount, currency });
    piId = intent.id;
    await db.card_attempts.update(saleId, { payment_intent_id: piId, state: 'collecting' });

    const collected = await t.collectPaymentMethod(intent.client_secret);
    if ('error' in collected) throw new Error(collected.error.message);

    const processed = await t.processPayment(collected.paymentIntent);
    if ('error' in processed) throw new Error(processed.error.message);

    await commitDraft(draft, [
      { method: 'card', amount_cents: amount, stripe_payment_intent_id: piId },
    ]);
  } catch (err) {
    // Only give up on the attempt if we are SURE no money moved. If processPayment
    // may have succeeded, leave it 'collecting' for reconcileCardAttempts().
    if (piId && !(await maybeCharged(piId))) {
      await api.cancelIntent(piId).catch(() => undefined);
      await db.card_attempts.update(saleId, { state: 'failed' });
    } else if (!piId) {
      await db.card_attempts.update(saleId, { state: 'failed' });
    }
    throw err;
  }
}

async function maybeCharged(piId: string): Promise<boolean> {
  try {
    const pi = await api.getIntent(piId);
    return pi.status === 'succeeded' || pi.status === 'processing';
  } catch {
    return true; // can't tell (offline): assume it might have, keep for reconciliation
  }
}

/**
 * Resolve card attempts whose outcome this device never saw (tab closed or
 * connection lost between "customer charged" and "sale saved"). Runs on every
 * reconnect, BEFORE the outbox is pushed.
 */
export async function reconcileCardAttempts(): Promise<number> {
  const open = await db.card_attempts.where('state').anyOf('creating', 'collecting').toArray();
  let resolved = 0;
  for (const a of open) {
    // The reader may still be mid-payment on this very device; skip very fresh attempts.
    if (Date.now() - Date.parse(a.created_at) < 2 * 60_000) continue;

    if (!a.payment_intent_id) {
      await db.card_attempts.update(a.sale_id, { state: 'failed' });
      resolved++;
      continue;
    }
    try {
      const pi = await api.getIntent(a.payment_intent_id);
      if (pi.status === 'succeeded') {
        await commitDraft(a.draft, [
          { method: 'card', amount_cents: pi.amount_received, stripe_payment_intent_id: pi.id },
        ]);
        resolved++;
      } else if (pi.status === 'processing') {
        continue; // still in flight; look again next time
      } else {
        await api.cancelIntent(a.payment_intent_id).catch(() => undefined);
        await db.card_attempts.update(a.sale_id, { state: 'failed' });
        resolved++;
      }
    } catch {
      // still can't reach the API; try again at the next transition
    }
  }
  return resolved;
}
