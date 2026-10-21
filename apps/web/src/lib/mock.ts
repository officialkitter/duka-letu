import type { Identity, Product, Role, Tenant } from './types';

/**
 * Demo mode: no Supabase. On when NEXT_PUBLIC_MOCK_MODE=true, or when no Supabase
 * URL is configured. If NEXT_PUBLIC_API_URL is also set the mock API (apps/api,
 * `npm run dev:mock`) is used; otherwise everything is answered locally.
 */
export const MOCK_MODE =
  process.env.NEXT_PUBLIC_MOCK_MODE === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export const MOCK_PASSWORD = 'demo1234';

export const MOCK_TENANT: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Duka Letu Demo Shop',
  currency: 'KES',
};

const ACCOUNTS: Record<string, { userId: string; role: Role }> = {
  'owner@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'owner' },
  'manager@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'manager' },
  'cashier@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'cashier' },
};

export function mockSignIn(email: string, password: string): Identity {
  const acct = ACCOUNTS[email.trim().toLowerCase()];
  if (!acct || password !== MOCK_PASSWORD) {
    throw new Error(`Demo login: owner@dukaletu.test / manager@dukaletu.test / cashier@dukaletu.test, password ${MOCK_PASSWORD}`);
  }
  return { userId: acct.userId, email: email.trim().toLowerCase(), tenantId: MOCK_TENANT.id, role: acct.role };
}

export const mockTokenFor = (role: Role) => `mock-token-${role}`;

const SEED_TS = '2026-01-01T00:00:00.000Z';
const p = (n: number, sku: string, name: string, price: number, tax: number): Product & { sync_ts: string } => ({
  id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
  sku,
  name,
  price_cents: price,
  tax_rate_bps: tax,
  active: true,
  deleted_at: null,
  sync_ts: SEED_TS,
});

export const MOCK_PRODUCTS = [
  p(1, 'DRK-001', 'Espresso', 15000, 1600),
  p(2, 'DRK-002', 'Cappuccino', 20000, 1600),
  p(3, 'DRK-003', 'Masala Chai', 12000, 1600),
  p(4, 'DRK-004', 'Fresh Mango Juice', 25000, 0),
  p(5, 'BKR-001', 'Butter Croissant', 18000, 1600),
  p(6, 'BKR-002', 'Mandazi (6 pack)', 10000, 0),
  p(7, 'BKR-003', 'Blueberry Muffin', 22000, 1600),
  p(8, 'MEL-001', 'Chicken Wrap', 42000, 1600),
  p(9, 'MEL-002', 'Veggie Samosa (3)', 15000, 0),
  p(10, 'MEL-003', 'Beef Burger', 55000, 1600),
  p(11, 'SNK-001', 'Roasted Cashews', 30000, 0),
  p(12, 'SNK-002', 'Dark Chocolate Bar', 28000, 1600),
];

export const MOCK_SEED_TS = SEED_TS;
