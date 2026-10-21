import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import type { DashboardData, Identity, Payment, Product, Sale, SaleLine, SyncResponse, SyncSale, Tenant } from './types';
import { localMockFetch, mockSignIn, mockTokenFor } from './mock';

const databaseName = 'duka-letu.db';
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');
export const MOCK_MODE =
  process.env.EXPO_PUBLIC_MOCK_MODE === 'true' || !supabaseUrl || !supabaseAnonKey;

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

let database: SQLite.SQLiteDatabase | null = null;
let initializing: Promise<SQLite.SQLiteDatabase> | null = null;

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (database) return database;
  if (initializing) return initializing;
  initializing = (async () => {
    const connection = await SQLite.openDatabaseAsync(databaseName);
    await connection.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY NOT NULL, sku TEXT, name TEXT NOT NULL,
        price_cents INTEGER NOT NULL, tax_rate_bps INTEGER NOT NULL,
        active INTEGER NOT NULL, deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, cashier_id TEXT NOT NULL,
        status TEXT NOT NULL, currency TEXT NOT NULL, subtotal_cents INTEGER NOT NULL,
        tax_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
        occurred_at TEXT NOT NULL, sync_status TEXT NOT NULL, sync_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS sales_occurred_idx ON sales(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS sales_sync_idx ON sales(sync_status);
      CREATE TABLE IF NOT EXISTS sale_lines (
        id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, product_id TEXT,
        name TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL,
        tax_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL,
        FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY NOT NULL, sale_id TEXT NOT NULL, method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, stripe_payment_intent_id TEXT,
        FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE
      );
    `);
    database = connection;
    return connection;
  })();
  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

export async function initializeDatabase(): Promise<void> {
  await db();
}

async function getMeta<T>(key: string): Promise<T | null> {
  const connection = await db();
  const row = await connection.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  const connection = await db();
  await connection.runAsync(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

function decodeClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('The sign-in response did not contain valid account claims.');
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
}

export async function getIdentity(): Promise<Identity | null> {
  return getMeta<Identity>('identity');
}

export async function setIdentity(email: string, password: string): Promise<Identity> {
  if (MOCK_MODE) {
    const identity = mockSignIn(email, password);
    await setMeta('identity', identity);
    return identity;
  }
  if (!supabase) {
    throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in apps/mobile/.env before signing in.');
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(error?.message ?? 'Sign-in failed.');

  const claims = decodeClaims(data.session.access_token);
  const tenantId = claims['tenant_id'];
  const role = claims['pos_role'];
  if (
    typeof tenantId !== 'string' ||
    (role !== 'owner' && role !== 'manager' && role !== 'cashier')
  ) {
    await supabase.auth.signOut();
    throw new Error('This account is not a member of a business yet.');
  }
  const identity: Identity = {
    userId: data.session.user.id,
    email: data.session.user.email ?? email,
    tenantId,
    role,
  };
  await setMeta('identity', identity);
  return identity;
}

export async function getDashboardData(): Promise<DashboardData> {
  const connection = await db();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const [products, sales, tenant, pending, rejected, today] = await Promise.all([
    connection.getAllAsync<Product>(
      'SELECT id, sku, name, price_cents, tax_rate_bps, active, deleted_at FROM products WHERE active = 1 AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
    ),
    connection.getAllAsync<Sale>('SELECT * FROM sales ORDER BY occurred_at DESC LIMIT 30'),
    getMeta<Tenant>('tenant'),
    connection.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM sales WHERE sync_status = 'pending'"),
    connection.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM sales WHERE sync_status = 'rejected'"),
    connection.getFirstAsync<{ total: number; count: number }>(
      `SELECT COALESCE(SUM(total_cents), 0) AS total, COUNT(*) AS count
       FROM sales WHERE status = 'completed' AND occurred_at >= ? AND occurred_at < ?`,
      dayStart.toISOString(),
      dayEnd.toISOString(),
    ),
  ]);
  return {
    products,
    sales,
    tenant,
    pending: pending?.count ?? 0,
    rejected: rejected?.count ?? 0,
    todaySalesTotal: today?.total ?? 0,
    todaySalesCount: today?.count ?? 0,
  };
}

export async function saveCashSale(
  items: { product: Product; quantity: number }[],
  identity: Identity,
  currency: string,
): Promise<void> {
  if (items.length === 0) throw new Error('Add at least one product before completing a sale.');
  let subtotal = 0;
  let tax = 0;
  const saleId = Crypto.randomUUID();
  const lines = items.map(({ product, quantity }) => {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Product quantities must be whole numbers.');
    if (quantity > 10_000) throw new Error('A sale cannot contain more than 10,000 of one product.');
    if (!Number.isSafeInteger(product.price_cents) || product.price_cents < 0) throw new Error('A product has an invalid price.');
    if (!Number.isInteger(product.tax_rate_bps) || product.tax_rate_bps < 0 || product.tax_rate_bps > 10_000) {
      throw new Error('A product has an invalid tax rate.');
    }
    const lineTotal = product.price_cents * quantity;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > 100_000_000) {
      throw new Error('A product line exceeds the maximum supported sale amount.');
    }
    const lineTax = Math.round((lineTotal * product.tax_rate_bps) / 10_000);
    subtotal += lineTotal;
    tax += lineTax;
    return {
      id: Crypto.randomUUID(),
      sale_id: saleId,
      product_id: product.id,
      name: product.name,
      quantity,
      unit_price_cents: product.price_cents,
      tax_cents: lineTax,
      line_total_cents: lineTotal,
    } satisfies SaleLine;
  });
  const total = subtotal + tax;
  if (
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    subtotal > 100_000_000 ||
    tax > 100_000_000 ||
    total > 100_000_000
  ) {
    throw new Error('The sale total must be between 1 cent and 1,000,000 in your store currency.');
  }

  const connection = await db();
  let deviceId = await getMeta<string>('deviceId');
  if (!deviceId) {
    deviceId = Crypto.randomUUID();
    await setMeta('deviceId', deviceId);
  }
  const occurredAt = new Date().toISOString();
  const payment: Payment = {
    id: Crypto.randomUUID(),
    sale_id: saleId,
    method: 'cash',
    amount_cents: total,
    stripe_payment_intent_id: null,
  };
  await connection.withTransactionAsync(async () => {
    await connection.runAsync(
      `INSERT INTO sales(
        id, device_id, cashier_id, status, currency, subtotal_cents, tax_cents,
        total_cents, occurred_at, sync_status, sync_reason
      ) VALUES(?, ?, ?, 'completed', ?, ?, ?, ?, ?, 'pending', NULL)`,
      saleId,
      deviceId,
      identity.userId,
      currency.toLowerCase(),
      subtotal,
      tax,
      total,
      occurredAt,
    );
    for (const line of lines) {
      await connection.runAsync(
        `INSERT INTO sale_lines(
          id, sale_id, product_id, name, quantity, unit_price_cents, tax_cents, line_total_cents
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        line.id,
        line.sale_id,
        line.product_id,
        line.name,
        line.quantity,
        line.unit_price_cents,
        line.tax_cents,
        line.line_total_cents,
      );
    }
    await connection.runAsync(
      'INSERT INTO payments(id, sale_id, method, amount_cents, stripe_payment_intent_id) VALUES(?, ?, ?, ?, NULL)',
      payment.id,
      payment.sale_id,
      payment.method,
      payment.amount_cents,
    );
  });
}

async function pendingSales(
  connection: SQLite.SQLiteDatabase,
  excluded: ReadonlySet<string> = new Set(),
): Promise<SyncSale[]> {
  const rows = await connection.getAllAsync<Sale>("SELECT * FROM sales WHERE sync_status = 'pending' ORDER BY occurred_at");
  const result: SyncSale[] = [];
  for (const sale of rows.filter((row) => !excluded.has(row.id)).slice(0, 100)) {
    const [lines, payments] = await Promise.all([
      connection.getAllAsync<SaleLine>('SELECT * FROM sale_lines WHERE sale_id = ?', sale.id),
      connection.getAllAsync<Payment>('SELECT * FROM payments WHERE sale_id = ?', sale.id),
    ]);
    result.push({
      id: sale.id,
      currency: sale.currency,
      subtotal_cents: sale.subtotal_cents,
      tax_cents: sale.tax_cents,
      total_cents: sale.total_cents,
      occurred_at: sale.occurred_at,
      lines: lines.map(({ sale_id: _saleId, ...line }) => line),
      payments: payments.map(({ sale_id: _saleId, ...payment }) => payment),
    });
  }
  return result;
}

const pullTables = ['products', 'sales', 'sale_lines', 'payments'] as const;
type PullTable = (typeof pullTables)[number];
type Cursors = Record<PullTable, string | null>;

function emptyCursors(): Cursors {
  return { products: null, sales: null, sale_lines: null, payments: null };
}

async function applySyncResponse(response: SyncResponse, cursors: Cursors): Promise<void> {
  const connection = await db();
  await connection.withTransactionAsync(async () => {
    for (const result of response.results) {
      if (result.status === 'accepted' || result.status === 'duplicate') {
        await connection.runAsync("UPDATE sales SET sync_status = 'synced', sync_reason = NULL WHERE id = ?", result.id);
      } else if (result.status === 'rejected') {
        await connection.runAsync(
          "UPDATE sales SET sync_status = 'rejected', sync_reason = ? WHERE id = ?",
          result.reason ?? 'rejected',
          result.id,
        );
      } else {
        await connection.runAsync('UPDATE sales SET sync_reason = ? WHERE id = ?', result.reason ?? 'retry', result.id);
      }
    }

    for (const product of response.pull.products.rows) {
      await connection.runAsync(
        `INSERT INTO products(id, sku, name, price_cents, tax_rate_bps, active, deleted_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sku = excluded.sku, name = excluded.name, price_cents = excluded.price_cents,
          tax_rate_bps = excluded.tax_rate_bps, active = excluded.active, deleted_at = excluded.deleted_at`,
        product.id,
        product.sku,
        product.name,
        product.price_cents,
        product.tax_rate_bps,
        product.active ? 1 : 0,
        product.deleted_at,
      );
    }

    for (const sale of response.pull.sales.rows) {
      await connection.runAsync(
        `INSERT INTO sales(
          id, device_id, cashier_id, status, currency, subtotal_cents, tax_cents,
          total_cents, occurred_at, sync_status, sync_reason
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)
        ON CONFLICT(id) DO UPDATE SET
          device_id = excluded.device_id, cashier_id = excluded.cashier_id, status = excluded.status,
          currency = excluded.currency, subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents,
          total_cents = excluded.total_cents, occurred_at = excluded.occurred_at,
          sync_status = CASE WHEN sales.sync_status = 'pending' THEN sales.sync_status ELSE 'synced' END`,
        sale.id,
        sale.device_id,
        sale.cashier_id,
        sale.status,
        sale.currency,
        sale.subtotal_cents,
        sale.tax_cents,
        sale.total_cents,
        sale.occurred_at,
      );
    }

    for (const line of response.pull.sale_lines.rows) {
      await connection.runAsync(
        `INSERT INTO sale_lines(id, sale_id, product_id, name, quantity, unit_price_cents, tax_cents, line_total_cents)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET sale_id = excluded.sale_id, product_id = excluded.product_id,
          name = excluded.name, quantity = excluded.quantity, unit_price_cents = excluded.unit_price_cents,
          tax_cents = excluded.tax_cents, line_total_cents = excluded.line_total_cents`,
        line.id,
        line.sale_id,
        line.product_id,
        line.name,
        line.quantity,
        line.unit_price_cents,
        line.tax_cents,
        line.line_total_cents,
      );
    }

    for (const payment of response.pull.payments.rows) {
      await connection.runAsync(
        `INSERT INTO payments(id, sale_id, method, amount_cents, stripe_payment_intent_id)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET sale_id = excluded.sale_id, method = excluded.method,
          amount_cents = excluded.amount_cents, stripe_payment_intent_id = excluded.stripe_payment_intent_id`,
        payment.id,
        payment.sale_id,
        payment.method,
        payment.amount_cents,
        payment.stripe_payment_intent_id,
      );
    }

    const nextCursors = { ...cursors };
    for (const table of pullTables) {
      nextCursors[table] = response.pull[table].cursor ?? cursors[table];
    }
    await connection.runAsync(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'cursors',
      JSON.stringify(nextCursors),
    );
    if (response.tenant) {
      await connection.runAsync(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        'tenant',
        JSON.stringify(response.tenant),
      );
    }
  });
}

export async function syncWithServer(): Promise<void> {
  let data: { session: { access_token: string } | null };
  if (MOCK_MODE) {
    const identity = await getIdentity();
    data = { session: identity ? { access_token: mockTokenFor(identity.role) } : null };
  } else {
    if (!supabase) throw new Error('Supabase is not configured. Check apps/mobile/.env.');
    if (!apiUrl) throw new Error('The sync API is not configured. Set EXPO_PUBLIC_API_URL in apps/mobile/.env.');
    const result = await supabase.auth.getSession();
    if (result.error) throw new Error(result.error.message);
    data = result.data;
  }
  if (!data.session) throw new Error('Please sign in again to sync this device.');
  const request = MOCK_MODE && !apiUrl ? localMockFetch : fetch;

  const connection = await db();
  let cursors = (await getMeta<Cursors>('cursors')) ?? emptyCursors();
  let firstPage = true;
  const attempted = new Set<string>();
  for (;;) {
    const sales = await pendingSales(connection, attempted);
    for (const sale of sales) attempted.add(sale.id);
    let deviceId = await getMeta<string>('deviceId');
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      await setMeta('deviceId', deviceId);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await request(`${apiUrl}/v1/sync`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${data.session.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deviceId,
          sales,
          pull: {
            cursors,
            overlapSeconds: firstPage ? 30 : 0,
            limit: 500,
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Sync timed out. Your local sales are safe; try again when your connection is stronger.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your session needs refreshing. Sign in again before syncing.');
      }
      throw new Error(body.error ?? `Sync failed (HTTP ${response.status}). Your local sales are safe.`);
    }

    const result = (await response.json()) as SyncResponse;
    await applySyncResponse(result, cursors);
    firstPage = false;
    cursors = (await getMeta<Cursors>('cursors')) ?? cursors;
    const hasMore = pullTables.some((table) => result.pull[table].hasMore);
    const hasUnattemptedSales = (await pendingSales(connection, attempted)).length > 0;
    if (!hasMore && !hasUnattemptedSales) break;
  }
}

export async function clearLocalData(): Promise<void> {
  if (supabase) {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw new Error(error.message);
  }
  const connection = await db();
  await connection.withTransactionAsync(async () => {
    await connection.execAsync('DELETE FROM payments; DELETE FROM sale_lines; DELETE FROM sales; DELETE FROM products; DELETE FROM meta;');
  });
  await AsyncStorage.removeItem('duka:last-user');
}
