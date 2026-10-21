import pg from 'pg';
import { env } from './env.js';
import type { Claims } from './auth.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: false }, // Supabase poolers present a managed cert chain
});

pool.on('error', (err) => {
  // An idle client died (e.g. pooler restart). The pool replaces it; just log.
  console.error('pg pool idle client error', err.message);
});

/**
 * Run `fn` inside a transaction whose RLS identity is the verified caller.
 *
 *  1. request.jwt.claims is set transaction-locally (same GUC Supabase's
 *     auth.jwt() reads), which app.tenant_id()/app.user_id() consume.
 *  2. `set local role authenticated` drops to a role WITHOUT bypassrls, so
 *     every policy in 0001_init.sql is enforced for all queries in `fn`.
 *
 * Tenant identity therefore comes only from the verified token, never from
 * request bodies or query strings.
 */
export async function withTenant<T>(
  claims: Claims,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: claims.sub,
        role: 'authenticated',
        tenant_id: claims.tenant_id,
        pos_role: claims.pos_role,
      }),
    ]);
    await client.query('set local role authenticated');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already broken; release below will discard it */
    }
    throw err;
  } finally {
    client.release();
  }
}
