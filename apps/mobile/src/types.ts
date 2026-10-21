export type Role = 'owner' | 'manager' | 'cashier';
export type SyncStatus = 'pending' | 'synced' | 'rejected';

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

export interface Sale {
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
  sync_reason: string | null;
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

export interface DashboardData {
  products: Product[];
  sales: Sale[];
  tenant: Tenant | null;
  pending: number;
  rejected: number;
  todaySalesTotal: number;
  todaySalesCount: number;
}

export interface SyncSale {
  id: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  occurred_at: string;
  lines: Omit<SaleLine, 'sale_id'>[];
  payments: Omit<Payment, 'sale_id'>[];
}

export interface SyncPage<T> {
  rows: (T & { sync_ts: string })[];
  cursor: string | null;
  hasMore: boolean;
}

export interface SyncResponse {
  results: { id: string; status: 'accepted' | 'duplicate' | 'rejected' | 'retry'; reason?: string }[];
  pull: {
    products: SyncPage<Product>;
    sales: SyncPage<Omit<Sale, 'sync_status' | 'sync_reason'>>;
    sale_lines: SyncPage<SaleLine>;
    payments: SyncPage<Payment>;
  };
  tenant: Tenant | null;
}
