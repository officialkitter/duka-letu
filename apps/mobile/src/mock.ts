import type { Identity } from './types';

/**
 * Demo mode: no Supabase. On when EXPO_PUBLIC_MOCK_MODE=true or when Supabase is not
 * configured. If EXPO_PUBLIC_API_URL is also set, the mock API (apps/api,
 * `npm run dev:mock`) is used; otherwise sync is answered on the device.
 */
export const MOCK_PASSWORD = 'demo1234';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const MOCK_TENANT = { id: TENANT_ID, name: 'Duka Letu Demo Shop', currency: 'KES' };

const ACCOUNTS: Record<string, { userId: string; role: Identity['role'] }> = {
  'owner@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'owner' },
  'manager@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'manager' },
  'cashier@dukaletu.test': { userId: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'cashier' },
};

export function mockSignIn(email: string, password: string): Identity {
  const key = email.trim().toLowerCase();
  const acct = ACCOUNTS[key];
  if (!acct || password !== MOCK_PASSWORD) {
    throw new Error(`Demo mode: use owner@, manager@ or cashier@dukaletu.test with password ${MOCK_PASSWORD}.`);
  }
  return { userId: acct.userId, email: key, tenantId: TENANT_ID, role: acct.role };
}

export const mockTokenFor = (role: Identity['role']) => `mock-token-${role}`;

const SEED_TS = '2026-01-01T00:00:00.000Z';
const p = (n: number, sku: string, name: string, price: number, tax: number) => ({
  id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
  sku,
  name,
  price_cents: price,
  tax_rate_bps: tax,
  active: true,
  deleted_at: null,
  sync_ts: SEED_TS,
});

const PRODUCTS = [
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

/** Stand-in for fetch(`${apiUrl}/v1/sync`) when no mock API is configured. */
export async function localMockFetch(_url: unknown, init?: { body?: unknown }): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    sales?: { id: string }[];
    pull?: { cursors?: Record<string, string | null> };
  };
  const cursors = body.pull?.cursors ?? {};
  const empty = (key: string) => ({ rows: [], cursor: cursors[key] ?? null, hasMore: false });
  await new Promise((r) => setTimeout(r, 300));
  return new Response(
    JSON.stringify({
      results: (body.sales ?? []).map((s) => ({ id: s.id, status: 'accepted' })),
      pull: {
        products: cursors['products']
          ? empty('products')
          : { rows: PRODUCTS, cursor: SEED_TS, hasMore: false },
        sales: empty('sales'),
        sale_lines: empty('sale_lines'),
        payments: empty('payments'),
      },
      tenant: MOCK_TENANT,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
