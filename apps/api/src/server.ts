import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env } from './env.js';

// Real-backend modules are loaded lazily so mock mode needs no DB/Stripe config.
const real = env.MOCK_MODE
  ? null
  : {
      ...(await import('./db.js')),
      ...(await import('./routes/sync.js')),
      ...(await import('./routes/terminal.js')),
    };

const app = Fastify({
  logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
  trustProxy: true, // Railway terminates TLS in front of the container
  bodyLimit: 1 * 1024 * 1024,
});

await app.register(cors, {
  origin: env.WEB_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['authorization', 'content-type'],
  maxAge: 86400,
});

await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

// Liveness: no dependencies, used by Railway's healthcheck.
app.get('/healthz', async () => ({ ok: true }));

// Readiness: proves the database is reachable.
app.get('/readyz', async (_req, reply) => {
  if (!real) return { ok: true, mock: true };
  try {
    await real.pool.query('select 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

if (real) {
  await app.register(real.syncRoutes);
  await app.register(real.terminalRoutes);
} else {
  const { mockRoutes } = await import('./routes/mock.js');
  await app.register(mockRoutes);
  app.log.warn('MOCK_MODE is on: in-memory demo data, no Supabase/Stripe. Not for production.');
}

app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, 'unhandled error');
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  // Never leak internals on 5xx.
  reply.code(status).send({ error: status >= 500 ? 'internal_error' : (err as Error).message });
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await real?.pool.end();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: env.PORT });
