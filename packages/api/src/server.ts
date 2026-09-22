import Fastify from 'fastify';
import Cors from '@fastify/cors';
import Helmet from '@fastify/helmet';
import Compress from '@fastify/compress';
import Websocket from '@fastify/websocket';
import RateLimit from '@fastify/rate-limit';
import Jwt from '@fastify/jwt';
import { errorHandler } from './middleware/error-handler';
import routes from './routes';
import { env } from './utils/env';
import { requestLogger, getPrometheusMetrics } from './utils/logging';
import { fullHealthReport, livenessReport } from './utils/health';

const server = async () => {
  const app = Fastify({
    // Lead imports post a chunk of parsed CSV as JSON; the 1 MB default would reject a
    // legitimate 2000-row batch. Row count and per-value length are capped in the importer.
    bodyLimit: Number(process.env.API_BODY_LIMIT_BYTES ?? 8 * 1024 * 1024),
    // trustProxy must match the actual trusted proxy hop count; off by default so
    // req.ip can't be spoofed via X-Forwarded-For (keeps rate-limiting honest).
    // Set TRUST_PROXY=true only when running behind a trusted reverse proxy.
    // (fastify 5 dropped the numeric-hop form; boolean trusts the leftmost
    // X-Forwarded-For entry, which is the single-proxy case this gate covers.)
    trustProxy: process.env.TRUST_PROXY === 'true',
    logger: env.NODE_ENV === 'development'
      ? { level: 'info' }
      : { level: 'warn', redact: ['req.headers.authorization'] },
  });

  // `origin: '*'` alongside credentials:true is the classic CORS mistake: browsers
  // reject it outright, and any deployment that loosened the response would let an
  // attacker's page read authenticated responses. With no explicit origin configured
  // we send no CORS headers at all, which is correct for the same-origin docker setup.
  await app.register(Cors, {
    origin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((o) => o.trim()) : false,
    credentials: true,
  });
  await app.register(Helmet);
  await app.register(Compress);
  // Lead imports post a chunk of parsed CSV as JSON. Fastify's 1 MB default would reject
  // a legitimate 2000-row batch; the route caps rows and per-value length separately.
  await app.register(RateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });
  await app.register(Jwt, {
    secret: {
      public: process.env.JWT_PUBLIC_KEY || env.JWT_SECRET,
      private: process.env.JWT_PRIVATE_KEY || env.JWT_SECRET,
    },
    sign: {
      expiresIn: env.JWT_EXPIRES_IN || '7d',
    },
  });
  await app.register(Websocket);

  app.addHook('preHandler', requestLogger);
  app.addHook('preHandler', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler(errorHandler);

  // /metrics is fail-closed. It previously answered 200 to anyone who could
  // reach the API port, and the payload enumerates every route, status code and
  // latency bucket -- a ready-made reconnaissance map of the deployment. With no
  // METRICS_TOKEN set the endpoint refuses rather than silently exposing itself,
  // so a missing env var shows up as a broken scrape, not a leak.
  app.get('/metrics', async (req, reply) => {
    const expected = env.METRICS_TOKEN;
    if (!expected) {
      req.log.warn('GET /metrics refused: METRICS_TOKEN is not configured');
      return reply.status(503).send({ error: 'Metrics endpoint is not configured' });
    }
    const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (presented !== expected) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return getPrometheusMetrics();
  });

  // Probe endpoints (master-prompt §39). /liveness never touches dependencies so a
  // DB blip cannot cause restart storms; /readiness gates traffic on DB+Redis and
  // returns 503 so a TCP-level healthcheck (or any non-200 probe) fails closed.
  app.get('/liveness', async () => livenessReport());
  app.get('/readiness', async (_req, reply) => {
    const report = await fullHealthReport();
    if (report.status !== 'ok') {
      return reply.status(503).send(report);
    }
    return report;
  });
  app.get('/health', async () => fullHealthReport());

  await app.register(routes, { prefix: '/api' });

  return app;
};

export default server;
