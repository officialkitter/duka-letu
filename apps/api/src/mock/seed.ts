import type { Claims } from '../auth.js';

export const MOCK_TENANT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Duka Letu Demo Shop',
  currency: 'KES',
} as const;

const claimsFor = (sub: string, role: Claims['pos_role']): Claims => ({
  sub,
  tenant_id: MOCK_TENANT.id,
  pos_role: role,
});

/** Bearer tokens accepted when MOCK_MODE=true. Clients use these after a demo sign-in. */
export const MOCK_TOKENS: Record<string, Claims> = {
  'mock-token-owner': claimsFor('aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
  'mock-token-manager': claimsFor('aaaaaaaa-0000-4000-8000-000000000002', 'manager'),
  'mock-token-cashier': claimsFor('aaaaaaaa-0000-4000-8000-000000000003', 'cashier'),
};

export const SEED_TS = '2026-01-01T00:00:00.000Z';

const product = (n: number, sku: string, name: string, price: number, taxBps: number) => ({
  id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
  sku,
  name,
  price_cents: price,
  tax_rate_bps: taxBps,
  active: true,
  deleted_at: null as string | null,
  sync_ts: SEED_TS,
});

export const MOCK_PRODUCTS = [
  product(1, 'DRK-001', 'Espresso', 15000, 1600),
  product(2, 'DRK-002', 'Cappuccino', 20000, 1600),
  product(3, 'DRK-003', 'Masala Chai', 12000, 1600),
  product(4, 'DRK-004', 'Fresh Mango Juice', 25000, 0),
  product(5, 'BKR-001', 'Butter Croissant', 18000, 1600),
  product(6, 'BKR-002', 'Mandazi (6 pack)', 10000, 0),
  product(7, 'BKR-003', 'Blueberry Muffin', 22000, 1600),
  product(8, 'MEL-001', 'Chicken Wrap', 42000, 1600),
  product(9, 'MEL-002', 'Veggie Samosa (3)', 15000, 0),
  product(10, 'MEL-003', 'Beef Burger', 55000, 1600),
  product(11, 'SNK-001', 'Roasted Cashews', 30000, 0),
  product(12, 'SNK-002', 'Dark Chocolate Bar', 28000, 1600),
];
