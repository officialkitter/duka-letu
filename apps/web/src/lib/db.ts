import Dexie, { type Table } from 'dexie';
import type { CardAttempt, LocalSale, Payment, Product, SaleLine } from './types';

interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * All business data the cashier needs lives here, so the register works with
 * no network. The server is the system of record; this is a durable replica
 * plus an outbox (sales with sync_status = 'pending').
 */
class PosDB extends Dexie {
  products!: Table<Product, string>;
  sales!: Table<LocalSale, string>;
  sale_lines!: Table<SaleLine, string>;
  payments!: Table<Payment, string>;
  card_attempts!: Table<CardAttempt, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('pos');
    this.version(1).stores({
      products: 'id, name, sku, active',
      sales: 'id, sync_status, occurred_at',
      sale_lines: 'id, sale_id',
      payments: 'id, sale_id',
      card_attempts: 'sale_id, state',
      meta: 'key',
    });
  }
}

export const db = new PosDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export async function getDeviceId(): Promise<string> {
  let id = await getMeta<string>('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    await setMeta('deviceId', id);
  }
  return id;
}
