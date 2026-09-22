/**
 * Health probe endpoints (master-prompt §39).
 *
 * These pin the contract orchestrators rely on:
 *  - /liveness is dependency-free and NEVER reports a dependency state (so a DB
 *    blip cannot trigger restart storms);
 *  - /readiness reports 503 while a dependency is down (fail closed);
 *  - /health aggregates the same detail for dashboards, always 200.
 *
 * The dependency checks are mocked at the module boundary: a route-level unit
 * test that really pings Postgres would tell us about the database, not about
 * the routing, status codes, or payload contract -- which is what matters here.
 * The real pings run in docker-compose healthchecks and scripts/verify_*.
 */
import { FastifyInstance } from 'fastify';

jest.mock('../src/utils/db', () => ({
  getDB: () => Object.assign(() => Promise.resolve([{ '?column?': 1 }]), { end: jest.fn() }),
}));

const mockPing = jest.fn().mockResolvedValue('PONG');
jest.mock('../src/utils/redis', () => ({
  getRedis: () => ({ ping: mockPing }),
}));

describe('Health probe endpoints', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockPing.mockReset().mockResolvedValue('PONG');
    const fastify = (require('fastify') as () => FastifyInstance)();
    const buildServer = require('../src/server').default;
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
  });

  test('liveness is dependency-free: 200 even when Postgres AND Redis are down', async () => {
    // Both dependencies fail; if the liveness handler ever touched them this
    // test would throw or report a dependency state and fail.
    mockPing.mockRejectedValue(new Error('redis gone'));

    const res = await app.inject({ method: 'GET', url: '/liveness' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('checks');
  });

  test('readiness returns 503 when Redis is down, naming the failed dependency', async () => {
    mockPing.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('down');
    expect(body.checks.redis.status).toBe('down');
    expect(body.checks.database.status).toBe('ok');
  });

  test('readiness returns the report when both dependencies are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
    expect(typeof body.checks.database.latency_ms).toBe('number');
  });

  test('health always answers 200 with the aggregate report (dashboard contract)', async () => {
    mockPing.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('down');
    expect(body.checks.redis.error).toBe('ECONNREFUSED');
  });

  test('legacy /api/health stays aliased to the full report', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('checks.database');
    expect(body).toHaveProperty('checks.redis');
  });
});
