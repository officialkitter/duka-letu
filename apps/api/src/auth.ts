import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import { MOCK_TOKENS } from './mock/seed.js';

export type PosRole = 'owner' | 'manager' | 'cashier';

export interface Claims extends JWTPayload {
  sub: string;
  tenant_id: string;
  pos_role: PosRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    claims: Claims;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly string[] = ['owner', 'manager', 'cashier'];

const issuer = `${(env.SUPABASE_URL ?? '').replace(/\/$/, '')}/auth/v1`;
const jwks = env.SUPABASE_JWKS_URL ? createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL)) : null;
const secret = env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET) : null;

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'missing_token' });
  }
  const token = header.slice('Bearer '.length);

  if (env.MOCK_MODE) {
    const claims = MOCK_TOKENS[token];
    if (!claims) return reply.code(401).send({ error: 'invalid_token' });
    req.claims = claims;
    return;
  }

  let payload: JWTPayload;
  try {
    const common = { issuer, audience: 'authenticated' };
    if (jwks) {
      ({ payload } = await jwtVerify(token, jwks, common));
    } else {
      ({ payload } = await jwtVerify(token, secret!, { ...common, algorithms: ['HS256'] }));
    }
  } catch {
    return reply.code(401).send({ error: 'invalid_token' });
  }

  const tenantId = payload['tenant_id'];
  const role = payload['pos_role'];
  if (
    typeof payload.sub !== 'string' ||
    typeof tenantId !== 'string' ||
    !UUID_RE.test(tenantId) ||
    typeof role !== 'string' ||
    !ROLES.includes(role)
  ) {
    // Authenticated user with no tenant membership (or hook not enabled).
    return reply.code(403).send({ error: 'no_tenant' });
  }

  req.claims = { ...payload, sub: payload.sub, tenant_id: tenantId, pos_role: role as PosRole };
}
