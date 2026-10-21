export type Role = 'owner' | 'manager' | 'cashier';

export interface Identity {
  userId: string;
  email: string;
  tenantId: string;
  role: Role;
}

export interface Tenant {
  id: string;
  name: string;
  currency: string;
}

export interface Product {
  id: string;
  sku: string | null;
  name: string;
  price_cents: number;
  tax_rate_bps: number;
  active: boolean;
  deleted_at: string | null;
}

export type SyncStatus = 'pending' | 'synced' | 'rejected';

export interface LocalSale {
  id: string;
  device_id: string;
  cashier_id: string;
  status: 'completed' | 'voided';
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  occurred_at: string;
  sync_status: SyncStatus;
  sync_reason?: string | null;
}

export interface SaleLine {
  id: string;
  sale_id: string;
  product_id: string | null;
  name: string;
  quantity: number;
  unit_price_cents: number;
  tax_cents: number;
  line_total_cents: number;
}

export interface Payment {
  id: string;
  sale_id: string;
  method: 'cash' | 'card';
  amount_cents: number;
  stripe_payment_intent_id: string | null;
}

/** A sale that has been built but not yet persisted as a completed sale. */
export interface DraftSale {
  sale: Omit<LocalSale, 'sync_status' | 'sync_reason'>;
  lines: SaleLine[];
}

/**
 * Written BEFORE a card is presented, so a crash/offline drop between
 * "customer charged" and "sale saved" can be reconciled against Stripe later.
 */
export interface CardAttempt {
  sale_id: string;
  payment_intent_id: string | null;
  amount_cents: number;
  state: 'creating' | 'collecting' | 'succeeded' | 'failed';
  draft: DraftSale;
  created_at: string;
}
