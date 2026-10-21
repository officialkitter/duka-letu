import { createClient } from '@supabase/supabase-js';
import { getMeta, setMeta, db } from './db';
import { MOCK_MODE, mockSignIn, mockTokenFor } from './mock';
import type { Identity, Role } from './types';

// In mock mode the client is never used; placeholders just keep createClient from throwing.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://localhost:54321',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'mock-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true } },
);

function decodeClaims(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Sign in (needs a connection). The resulting identity is cached in IndexedDB so
 * the register keeps working offline for the whole shift, even after the short-
 * lived access token expires; the token is only needed when we talk to the API.
 */
export async function signIn(email: string, password: string): Promise<Identity> {
  if (MOCK_MODE) {
    const identity = mockSignIn(email, password);
    await setMeta('identity', identity);
    return identity;
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(error?.message ?? 'Sign-in failed');

  const claims = decodeClaims(data.session.access_token);
  const tenantId = claims['tenant_id'];
  const role = claims['pos_role'];
  if (typeof tenantId !== 'string' || typeof role !== 'string') {
    await supabase.auth.signOut();
    throw new Error('This account is not a member of any business yet.');
  }
  const identity: Identity = {
    userId: data.session.user.id,
    email: data.session.user.email ?? email,
    tenantId,
    role: role as Role,
  };
  await setMeta('identity', identity);
  return identity;
}

export async function loadIdentity(): Promise<Identity | undefined> {
  return getMeta<Identity>('identity');
}

/** Sign out and wipe the local replica so a shared device never leaks tenant data. */
export async function signOut(opts: { force?: boolean } = {}): Promise<{ unsynced: number }> {
  const unsynced = await db.sales.where('sync_status').equals('pending').count();
  if (unsynced > 0 && !opts.force) return { unsynced };
  await supabase.auth.signOut().catch(() => undefined);
  await Promise.all(db.tables.map((t) => t.clear()));
  return { unsynced: 0 };
}

/** A valid access token, refreshed if needed; null when offline/expired. */
export async function getAccessToken(): Promise<string | null> {
  if (MOCK_MODE) {
    const id = await loadIdentity();
    return id ? mockTokenFor(id.role) : null;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
