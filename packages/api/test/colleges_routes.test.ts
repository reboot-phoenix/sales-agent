import { FastifyInstance } from 'fastify';

/**
 * College intelligence API.
 *
 * Colleges are the hardest domain to get right because the value is entirely in
 * the contacts: a college with no TPO is not a lead. These tests pin down that
 * contacts come back ranked by outreach priority, that coverage is reported
 * honestly, and that a failed enrichment worker surfaces as a retryable 502
 * instead of a fake success.
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
jest.mock('../src/utils/audit', () => ({ logAuditEvent: jest.fn().mockResolvedValue(undefined) }));

const mockUnsafe = jest.fn();
const COLLEGE_ID = '22222222-2222-4222-8222-222222222222';

function sqlTexts(): string[] {
  return mockUnsafe.mock.calls.map((c: any[]) => c[0] as string);
}

describe('Colleges API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockUnsafe.mockReset();
    mockUnsafe.mockResolvedValue([]);
    const fastify = (require('fastify') as () => FastifyInstance)();
    const { collegesRoutes } = require('../src/routes/colleges');
    fastify.register(collegesRoutes, { prefix: '/colleges' });
    app = fastify;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
  });

  test('contacts are fetched in outreach-priority order (TPO first)', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM colleges WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      if (/FROM college_contacts/.test(query)) {
        return [
          { id: 'c1', role_category: 'tpo', priority: 'P0', full_name: 'A B Sharma', email: 'tpo@college.edu' },
          { id: 'c2', role_category: 'principal', priority: 'P1', full_name: 'C D Rao', email: 'principal@college.edu' },
        ];
      }
      return [];
    });

    const res = await app.inject({ method: 'GET', url: `/colleges/${COLLEGE_ID}/contacts` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.contacts.map((c: any) => c.role_category)).toEqual(['tpo', 'principal']);
    const contactsSql = sqlTexts().find((q) => /FROM college_contacts/.test(q))!;
    expect(contactsSql).toMatch(/ORDER BY priority/);
  });

  test('state coverage reports TPO coverage separately from enrichment', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/with_tpo/.test(query)) {
        return [{ state: 'Karnataka', total: 40, enriched: 12, with_tpo: 9 }];
      }
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/colleges/states' });

    expect(res.statusCode).toBe(200);
    const { states } = JSON.parse(res.body);
    expect(states[0]).toEqual({ state: 'Karnataka', total: 40, enriched: 12, with_tpo: 9 });
  });

  test('analytics separate contact coverage by role instead of one vague number', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(DISTINCT state\)/.test(query)) return [{ total: 500, states_covered: 20 }];
      if (/FROM college_contacts/.test(query) && /contacts/.test(query)) {
        return [{ contacts: 300, tpo_roles: 120, principals: 80, directors: 40, deans: 20, hods: 15, emails: 200, phones: 90 }];
      }
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/colleges/eda' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.measured).toBe(true);
    expect(body.tpo_roles).toBe(120);
    expect(body.principals).toBe(80);
    expect(body.contacts_total).toBe(300);
  });

  test('claim race resolves to one owner and one explicit 409', async () => {
    let owner: string | null = null;
    mockUnsafe.mockImplementation(async (query: string, params: any[] = []) => {
      if (/UPDATE colleges/.test(query) && /claimed_by = \$1/.test(query)) {
        if (owner === null) {
          owner = params[0];
          return [{ id: params[1], claimed_by: params[0], assigned_to: null }];
        }
        return [];
      }
      if (/SELECT t\.claimed_by/.test(query)) return [{ claimed_by: owner, claimed_by_email: `${owner}@example.com` }];
      return [];
    });

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/colleges/${COLLEGE_ID}/claim`, headers: { 'x-test-user': 'rep-a' } }),
      app.inject({ method: 'POST', url: `/colleges/${COLLEGE_ID}/claim`, headers: { 'x-test-user': 'rep-b' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(owner).toMatch(/^rep-[ab]$/);
  });

  test('enrichment is queued to the worker and audit-logged on success', async () => {
    const { logAuditEvent } = require('../src/utils/audit');
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM colleges WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      return [];
    });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ run_id: 'run-1', status: 'queued' }),
    });
    global.fetch = fetchMock as any;

    const res = await app.inject({ method: 'POST', url: `/colleges/${COLLEGE_ID}/enrich` });

    expect(res.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/intelligence/colleges/${COLLEGE_ID}/enrich`);
    // The worker secret belongs to the server, never to the browser payload.
    expect((init.headers as any)['x-worker-key']).toBeDefined();
    expect(logAuditEvent).toHaveBeenCalled();
  });

  test('enrichment surfaces a worker outage as a retryable 502, not a fake 202', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM colleges WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      return [];
    });
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    const res = await app.inject({ method: 'POST', url: `/colleges/${COLLEGE_ID}/enrich` });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe('Worker unreachable');
  });

  test('notes require a non-empty body and are stored per domain', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/colleges/${COLLEGE_ID}/notes`,
      payload: { body: '' },
    });
    expect(empty.statusCode).toBe(400);

    mockUnsafe.mockImplementation(async (query: string, params: any[] = []) => {
      if (/SELECT 1 FROM colleges WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      if (/INSERT INTO lead_notes/.test(query)) return [{ id: 'n1', domain: 'college', body: params[1] }];
      return [];
    });

    const res = await app.inject({
      method: 'POST',
      url: `/colleges/${COLLEGE_ID}/notes`,
      payload: { body: 'Placement cell email bounces; use TPO personal.' },
    });
    expect(res.statusCode).toBe(200);
    expect(sqlTexts().some((q) => /INSERT INTO lead_notes/.test(q))).toBe(true);
    const noteInsert = mockUnsafe.mock.calls.find((c: any[]) => /INSERT INTO lead_notes/.test(c[0] as string))!;
    expect(noteInsert[0]).toContain("VALUES ('college'");
  });

  test('ownership and enrichment history are readable for a visible lead only', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM colleges WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      if (/FROM enrichment_runs/.test(query)) {
        return [{ id: 'e1', status: 'completed', contacts_found: 3, stages: ['sources', 'contacts'] }];
      }
      return [];
    });

    const ok = await app.inject({ method: 'GET', url: `/colleges/${COLLEGE_ID}/enrichment` });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).runs[0].contacts_found).toBe(3);

    mockUnsafe.mockImplementation(async () => []);
    const hidden = await app.inject({ method: 'GET', url: `/colleges/${COLLEGE_ID}/enrichment` });
    expect(hidden.statusCode).toBe(404);
  });

  test('list filters reject impossible values and clamp the page size', async () => {
    const bad = await app.inject({ method: 'GET', url: '/colleges?limit=0' });
    expect(bad.statusCode).toBe(400);
    const tooBig = await app.inject({ method: 'GET', url: '/colleges?limit=1000' });
    expect(tooBig.statusCode).toBe(400);
  });
});
