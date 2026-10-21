import { getAccessToken } from './supabase';
import { MOCK_MODE, MOCK_PRODUCTS, MOCK_SEED_TS, MOCK_TENANT } from './mock';
import type { LocalSale, Payment, SaleLine } from './types';

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

/** Answers API calls in-browser when mock mode is on and no API URL is configured. */
async function localMock<T>(method: string, path: string, body: unknown): Promise<T> {
  await new Promise((r) => setTimeout(r, 250));
  const empty = (cursor: string | null) => ({ rows: [], cursor, hasMore: false });
  if (path === '/v1/sync') {
    const b = body as { sales: { id: string }[]; pull: { cursors: Record<string, string | null> } };
    const first = !b.pull.cursors['products'];
    return {
      results: b.sales.map((s) => ({ id: s.id, status: 'accepted' })),
      pull: {
        products: first
          ? { rows: MOCK_PRODUCTS, cursor: MOCK_SEED_TS, hasMore: false }
          : empty(b.pull.cursors['products'] ?? null),
        sales: empty(b.pull.cursors['sales'] ?? null),
        sale_lines: empty(b.pull.cursors['sale_lines'] ?? null),
        payments: empty(b.pull.cursors['payments'] ?? null),
      },
      tenant: MOCK_TENANT,
    } as T;
  }
  if (path === '/v1/terminal/config') return { locationId: 'tml_mock' } as T;
  if (path === '/v1/terminal/connection-token') return { secret: 'pst_mock' } as T;
  if (path === '/v1/terminal/payment-intents' && method === 'POST') {
    const b = body as { amount_cents: number };
    const id = `pi_mock${Math.random().toString(16).slice(2, 12)}`;
    sessionStorage.setItem(id, String(b.amount_cents));
    return { id, client_secret: `${id}_secret` } as T;
  }
  const m = /^\/v1\/terminal\/payment-intents\/([^/]+)(\/cancel)?$/.exec(path);
  if (m) {
    if (m[2]) return { ok: true } as T;
    const amount = Number(sessionStorage.getItem(m[1]!) ?? 0);
    return { id: m[1], status: 'succeeded', amount_received: amount, currency: 'kes' } as T;
  }
  throw new ApiError(404, 'not_found');
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, 'no_session');
  if (MOCK_MODE && !BASE) return localMock<T>(method, path, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? `http_${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- sync ---- */

export interface SyncSaleIn extends Pick<
  LocalSale,
  'id' | 'currency' | 'subtotal_cents' | 'tax_cents' | 'total_cents' | 'occurred_at'
> {
  lines: Omit<SaleLine, 'sale_id'>[];
  payments: Omit<Payment, 'sale_id'>[];
}

export interface SyncResult {
  id: string;
  status: 'accepted' | 'duplicate' | 'rejected' | 'retry';
  reason?: string;
}

export interface PullPage<T> {
  rows: (T & { sync_ts: string })[];
  cursor: string | null;
  hasMore: boolean;
}

export interface SyncResponse {
  results: SyncResult[];
  pull: {
    products: PullPage<import('./types').Product>;
    sales: PullPage<Omit<LocalSale, 'sync_status' | 'sync_reason'>>;
    sale_lines: PullPage<SaleLine>;
    payments: PullPage<Payment>;
  };
  tenant: import('./types').Tenant | null;
}

export const api = {
  sync: (body: {
    deviceId: string;
    sales: SyncSaleIn[];
    pull: { cursors: Record<string, string | null>; overlapSeconds: number; limit: number };
  }) => request<SyncResponse>('POST', '/v1/sync', body),

  terminalConfig: () => request<{ locationId: string | null }>('GET', '/v1/terminal/config'),
  connectionToken: () => request<{ secret: string }>('POST', '/v1/terminal/connection-token'),
  createIntent: (b: { saleId: string; amount_cents: number; currency: string }) =>
    request<{ id: string; client_secret: string }>('POST', '/v1/terminal/payment-intents', b),
  getIntent: (id: string) =>
    request<{ id: string; status: string; amount_received: number; currency: string }>(
      'GET',
      `/v1/terminal/payment-intents/${id}`,
    ),
  cancelIntent: (id: string) =>
    request<{ ok: true }>('POST', `/v1/terminal/payment-intents/${id}/cancel`),
};
