import { FastifyInstance } from 'fastify';

/**
 * Scraper-army control plane.
 *
 * The API is a thin authenticated proxy: the browser must never hold the worker
 * secret, and a worker outage must be visible as a 502 (so the operator can
 * retry) rather than swallowed. These tests cover the proxy contract, the
 * admin-only gate on spending a run, and request validation.
 */

jest.mock('../src/middleware/auth', () => ({
  authenticate: jest.fn(async (req: any) => {
    req.user = {
      id: (req.headers['x-test-user'] as string) || 'user-1',
      email: 'rep@example.com',
      role: (req.headers['x-test-role'] as string) || 'sales_rep',
    };
  }),
  authorize: (roles: string[]) => jest.fn(async (req: any, reply: any) => {
    const role = (req.headers['x-test-role'] as string) || 'sales_rep';
    req.user = { id: (req.headers['x-test-user'] as string) || 'user-1', email: 'rep@example.com', role };
    if (!roles.includes(role)) {
      reply.status(403).send({ error: 'Forbidden: insufficient permissions' });
    }
  }),
}));

jest.mock('../src/utils/audit', () => ({ logAuditEvent: jest.fn().mockResolvedValue(undefined) }));

const RUN_ID = '33333333-3333-4333-8333-333333333333';

describe('Armies API (worker proxy)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const fastify = (require('fastify') as () => FastifyInstance)();
    const { armiesRoutes } = require('../src/routes/armies');
    fastify.register(armiesRoutes, { prefix: '/armies' });
    app = fastify;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
    delete process.env.WORKERS_URL;
  });

  function mockWorker(impl: (url: string, init: any) => Promise<any>) {
    const fetchMock = jest.fn(impl);
    global.fetch = fetchMock as any;
    return fetchMock;
  }

  test('starting an army returns 202 with the run id and forwards the trigger', async () => {
    const fetchMock = mockWorker(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ run_id: RUN_ID, status: 'running' }),
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/armies/hackathons/run',
      headers: { 'x-test-role': 'admin', 'x-test-user': 'admin-1' },
      payload: { sources: ['devpost'], run_type: 'manual' },
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).run_id).toBe(RUN_ID);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/armies/hackathons/run');
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({ sources: ['devpost'], run_type: 'manual', triggered_by: 'admin-1' }),
    );
    // The worker credential is attached server-side.
    expect(init.headers['x-worker-key']).toBeDefined();
  });

  test('all three armies can be launched in one call', async () => {
    const fetchMock = mockWorker(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ run_ids: { jobs: 'r1', hackathons: 'r2', colleges: 'r3' } }),
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/armies/run-all',
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).run_ids.colleges).toBe('r3');
    expect(fetchMock.mock.calls[0][0]).toContain('/armies/run-all');
  });

  test('a sales_rep cannot start an army', async () => {
    const fetchMock = mockWorker(async () => ({ ok: true, status: 202, json: async () => ({}) }));

    for (const path of ['/armies/jobs/run', '/armies/hackathons/run', '/armies/colleges/run', '/armies/run-all']) {
      const res = await app.inject({ method: 'POST', url: path, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an unreachable worker is a 502 the operator can retry', async () => {
    mockWorker(async () => {
      throw new Error('ECONNREFUSED');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/armies/colleges/run',
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toContain('worker unreachable');
  });

  test('invalid run bodies are rejected without calling the worker', async () => {
    const fetchMock = mockWorker(async () => ({ ok: true, status: 202, json: async () => ({}) }));

    const res = await app.inject({
      method: 'POST',
      url: '/armies/jobs/run',
      headers: { 'x-test-role': 'admin' },
      payload: { run_type: 'whenever' },
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('runs list and progress are proxied for reps (operational, not business data)', async () => {
    const fetchMock = mockWorker(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/runs/') ? { run: { id: RUN_ID, status: 'running' } } : { runs: [] }),
    }));

    const list = await app.inject({ method: 'GET', url: '/armies/runs?domain=hackathons&limit=5' });
    expect(list.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain('domain=hackathons');

    const detail = await app.inject({ method: 'GET', url: `/armies/runs/${RUN_ID}` });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).run.status).toBe('running');
  });

  test('a malformed run id never reaches the worker', async () => {
    const fetchMock = mockWorker(async () => ({ ok: true, status: 200, json: async () => ({}) }));

    const res = await app.inject({ method: 'GET', url: '/armies/runs/not-a-uuid' });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a worker-side 404 is passed through rather than remapped to 500', async () => {
    mockWorker(async () => ({ ok: false, status: 404, json: async () => ({ error: 'run not found' }) }));

    const res = await app.inject({ method: 'GET', url: `/armies/runs/${RUN_ID}` });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('run not found');
  });

  test('source health is proxied with the domain filter', async () => {
    const fetchMock = mockWorker(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sources: [{ name: 'devpost', health_status: 'healthy' }] }),
    }));

    const res = await app.inject({ method: 'GET', url: '/armies/sources?domain=colleges' });

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain('/armies/sources?domain=colleges');
  });
});
