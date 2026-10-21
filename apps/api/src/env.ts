import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const Schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.string().default('development'),
    WEB_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
    // When true the API runs entirely in memory with demo data: no Supabase,
    // Postgres or Stripe credentials are needed. Never enable in production.
    MOCK_MODE: flag,
    DATABASE_URL: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_JWKS_URL: z.string().url().optional(),
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_TERMINAL_LOCATION_ID: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.MOCK_MODE) return;
    for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'STRIPE_SECRET_KEY'] as const) {
      if (!e[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required unless MOCK_MODE=true` });
    }
    if (!e.SUPABASE_JWT_SECRET && !e.SUPABASE_JWKS_URL) {
      ctx.addIssue({ code: 'custom', message: 'Set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL' });
    }
  });

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten());
  process.exit(1);
}

export const env = parsed.data;
