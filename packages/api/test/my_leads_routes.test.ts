import { FastifyInstance } from 'fastify';

/**
 * My Leads — three domain sections, one ownership rule.
 *
 * Every section must return only rows the caller owns (claimed OR assigned),
 * including for admins (the full pool lives on the domain pages). A leak here
 * would show one rep another rep's pipeline, so the SQL scope is asserted
 * directly rather than only through the returned payload.
 */

jest.mock('../src/middleware/auth', () => ({
  authenticate: jest.fn(async (req: any) => {
    req.user = {
      id: (req.headers['x-test-user'] as string) || 'user-1',
      email: 'rep@example.com',
      role: (req.headers['x-test-role'] as string) || 'sales_rep',
    };
  }),
  authorize: () => jest.fn(async (req: any) => {
    req.user = {
      id: (req.headers['x-test-user'] as string) || 'user-1',
      email: 'rep@example.com',
      role: (req.headers['x-test-role'] as string) || 'sales_rep',
    };
  }),
}));

jest.mock('../src/utils/db', () => ({ getDB: () => ({ unsafe: mockUnsafe }) }));

const mockUnsafe = jest.fn();

function findByRegex(re: RegExp) {
  return mockUnsafe.mock.calls.find((c: any[]) => re.test(c[0] as string));
}

describe('My Leads API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockUnsafe.mockReset();
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });
    const fastify = (require('fastify') as () => FastifyInstance)();
    const { myLeadsRoutes } = require('../src/routes/myLeads');
    fastify.register(myLeadsRoutes, { prefix: '/my-leads' });
    app = fastify;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test.each([
    ['/my-leads/jobs', /l\.assigned_to = \$1 OR l\.claimed_by = \$1/],
    ['/my-leads/hackathons', /h\.assigned_to = \$1 OR h\.claimed_by = \$1/],
    ['/my-leads/colleges', /c\.assigned_to = \$1 OR c\.claimed_by = \$1/],
  ])('%s is scoped to the caller', async (url, pattern) => {
    const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': 'rep-7' } });

    expect(res.statusCode).toBe(200);
    const scoped = mockUnsafe.mock.calls.filter((c: any[]) => pattern.test(c[0] as string));
    expect(scoped.length).toBeGreaterThanOrEqual(2); // count + page query
    for (const call of scoped) {
      expect(call[1][0]).toBe('rep-7');
    }
  });

  test('an admin is scoped to their own leads here, not the whole pool', async () => {
    await app.inject({
      method: 'GET',
      url: '/my-leads/jobs',
      headers: { 'x-test-user': 'admin-1', 'x-test-role': 'admin' },
    });

    const scoped = findByRegex(/l\.assigned_to = \$1 OR l\.claimed_by = \$1/);
    expect(scoped).toBeDefined();
    expect(scoped![1][0]).toBe('admin-1');
  });

  test('each domain keeps its own filters instead of a generic status column', async () => {
    await app.inject({ method: 'GET', url: '/my-leads/jobs?pipeline_stage=replied&freshness=fresh' });
    const jobsSql = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((q) => /FROM leads l/.test(q))
      .join(' ');
    expect(jobsSql).toContain('l.pipeline_stage =');
    expect(jobsSql).toContain('jp.freshness_category =');

    mockUnsafe.mockClear();
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });
    await app.inject({ method: 'GET', url: '/my-leads/hackathons?status=REGISTRATION_OPEN&outreach_readiness=OUTREACH_READY' });
    const hackathonSql = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((q) => /FROM hackathons h/.test(q))
      .join(' ');
    expect(hackathonSql).toContain('h.status =');
    expect(hackathonSql).toContain('h.outreach_readiness =');
  });

  test('search terms are wildcard-escaped per domain', async () => {
    await app.inject({ method: 'GET', url: '/my-leads/colleges?q=100%25' });

    const params = mockUnsafe.mock.calls
      .map((c: any[]) => (c[1] || []) as any[])
      .find((p) => p.some((v) => typeof v === 'string' && v.includes('100')))!;
    expect(params).toContain('%100\\%%');
  });

  test('pagination is clamped', async () => {
    const res = await app.inject({ method: 'GET', url: '/my-leads/hackathons?limit=5000' });
    expect(res.statusCode).toBe(400);
  });

  test('summary reports the three domains separately', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/FROM leads l/.test(query)) return [{ total: 5, contacted: 2, new_leads: 3 }];
      if (/FROM hackathons h/.test(query)) return [{ total: 4, ready: 1, predicted: 2 }];
      if (/FROM colleges c/.test(query)) return [{ total: 9, ready: 6, needs_enrichment: 2 }];
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/my-leads/summary', headers: { 'x-test-user': 'rep-2' } });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jobs.total).toBe(5);
    expect(body.hackathons.predicted).toBe(2);
    expect(body.colleges.needs_enrichment).toBe(2);
    for (const call of mockUnsafe.mock.calls) {
      expect(call[1][0]).toBe('rep-2');
    }
  });
});
