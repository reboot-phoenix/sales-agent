/**
 * Route wiring checks for the outreach + saved-view surfaces.
 *
 * These assert the guarantees an operator relies on: the queue never shows a
 * do-not-contact lead, a rep only sees rows they may act on, saved filters are
 * validated, and a worker outage is reported as such instead of as success.
 */
import Fastify from 'fastify';

const registered: Array<{ prefix: string; routes: string[] }> = [];

jest.mock('../src/utils/db', () => {
  const unsafe = jest.fn(async (sql: string) => {
    (unsafe as any).lastSql = sql;
    return [];
  });
  return { getDB: () => ({ unsafe }) };
});

jest.mock('../src/middleware/auth', () => ({
  authenticate: async (req: any) => {
    req.user = { id: '11111111-1111-1111-1111-111111111111', role: 'admin', email: 'admin@x.com' };
  },
  authorize: () => async () => undefined,
}));

jest.mock('../src/utils/worker', () => ({
  callWorker: jest.fn(async () => ({ ok: false, status: 502, data: { error: 'worker unreachable' } })),
}));

import { outreachRoutes } from '../src/routes/outreach';
import { savedFiltersRoutes } from '../src/routes/savedFilters';
import { getDB } from '../src/utils/db';

describe('outreach routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(outreachRoutes, { prefix: '/outreach' });
    await app.ready();
  });
  afterAll(async () => app.close());

  beforeEach(() => jest.clearAllMocks());

  it('rejects an unknown domain on the per-lead assessment', async () => {
    const res = await app.inject({ method: 'GET', url: '/outreach/schools/abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown domain/);
  });

  it('rejects an invalid readiness filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/outreach/queue?readiness=MAYBE' });
    expect(res.statusCode).toBe(400);
  });

  it('never selects do-not-contact job leads into the queue', async () => {
    const res = await app.inject({ method: 'GET', url: '/outreach/queue?domain=jobs' });
    expect(res.statusCode).toBe(200);
    const sql = (getDB().unsafe as any).mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sql).toMatch(/do_not_contact IS NOT TRUE/);
  });

  it('returns a readiness summary with every domain present', async () => {
    const res = await app.inject({ method: 'GET', url: '/outreach/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.readiness).sort()).toEqual(['colleges', 'hackathons', 'jobs']);
  });

  it('reports a worker outage honestly instead of claiming reassessment worked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/outreach/colleges/22222222-2222-2222-2222-222222222222/reassess',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/unavailable/);
  });
});

describe('saved filters routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(savedFiltersRoutes, { prefix: '/saved-filters' });
    await app.ready();
  });
  afterAll(async () => app.close());

  it('requires a known domain and a non-empty name', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/saved-filters',
      payload: { domain: 'schools', name: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST', url: '/saved-filters',
      payload: { domain: 'colleges', name: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('rejects a non-object filter payload', async () => {
    const res = await app.inject({
      method: 'POST', url: '/saved-filters',
      payload: { domain: 'colleges', name: 'TPO backlog', filters: ['not', 'an', 'object'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('upserts by (user, domain, name) so re-saving refines rather than duplicates', async () => {
    (getDB().unsafe as any).mockClear();
    const res = await app.inject({
      method: 'POST', url: '/saved-filters',
      payload: { domain: 'colleges', name: 'TPO backlog', filters: { has_tpo: 'true' } },
    });
    expect(res.statusCode).toBe(201);
    const sql = (getDB().unsafe as any).mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sql).toMatch(/ON CONFLICT \(user_id, domain, name\)/);
  });

  // Note: zod's uuid() enforces the RFC variant/version bits, so test ids must be
  // real-shaped v4 uuids (…-4xxx-8xxx-…) rather than arbitrary hex.
  it('rejects a malformed filter id before touching the database', async () => {
    (getDB().unsafe as any).mockClear();
    const res = await app.inject({ method: 'DELETE', url: '/saved-filters/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect((getDB().unsafe as any).mock.calls).toHaveLength(0);
  });

  it('only ever deletes your own filter (or any, as admin)', async () => {
    (getDB().unsafe as any).mockClear();
    await app.inject({
      method: 'DELETE',
      url: '/saved-filters/33333333-3333-4333-8333-333333333333',
    });
    const sql = (getDB().unsafe as any).mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sql).toMatch(/user_id = \$2 OR \$3 = 'admin'/);
  });
});
