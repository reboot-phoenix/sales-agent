import { FastifyInstance } from 'fastify';

/**
 * Hackathon lead API.
 *
 * The point of these tests is the contract that makes the hackathon domain
 * trustworthy: predictions never masquerade as confirmed rows, a claim race has
 * exactly one winner, and a lead owned by someone else is invisible (404) rather
 * than merely forbidden. The caller identity comes from a header so two requests
 * can be in flight as two different reps — that is what makes the race real.
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
jest.mock('../src/utils/worker', () => ({ callWorker: jest.fn().mockResolvedValue({ ok: true, status: 202, data: { queued: true } }) }));

const mockUnsafe = jest.fn();
const LEAD_ID = '11111111-1111-4111-8111-111111111111';

type Call = { sql: string; params: any[] };

function callsMatching(needle: RegExp): Call[] {
  return mockUnsafe.mock.calls
    .map((c: any[]) => ({ sql: c[0] as string, params: (c[1] || []) as any[] }))
    .filter((c) => needle.test(c.sql));
}

describe('Hackathons API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockUnsafe.mockReset();
    mockUnsafe.mockResolvedValue([]);
    const fastify = (require('fastify') as () => FastifyInstance)();
    const { hackathonsRoutes } = require('../src/routes/hackathons');
    fastify.register(hackathonsRoutes, { prefix: '/hackathons' });
    app = fastify;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test('rep scope includes the unclaimed pool so claiming stays reachable', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/hackathons?limit=10' });

    expect(res.statusCode).toBe(200);
    const listQuery = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .find((q) => /FROM hackathons h/.test(q) && /ORDER BY/.test(q));
    expect(listQuery).toBeDefined();
    expect(listQuery).toContain('(h.assigned_to = $1 OR h.claimed_by = $2 OR (h.claimed_by IS NULL AND h.assigned_to IS NULL))');
    // Both placeholders must carry the caller's id, not someone else's.
    const params = mockUnsafe.mock.calls.find((c: any[]) => /ORDER BY/.test(c[0] as string))?.[1];
    expect(params.slice(0, 2)).toEqual(['user-1', 'user-1']);
  });

  test('an admin sees the whole pool — the ownership clause is not injected', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons',
      headers: { 'x-test-role': 'admin', 'x-test-user': 'admin-1' },
    });

    expect(res.statusCode).toBe(200);
    const listQuery = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .find((q) => /FROM hackathons h/.test(q) && /ORDER BY/.test(q))!;
    expect(listQuery).not.toContain('h.assigned_to =');
  });

  test('predicted=true and predicted=false are disjoint, explicit filters', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });

    await app.inject({ method: 'GET', url: '/hackathons?predicted=true' });
    let listQuery = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((q) => /FROM hackathons h/.test(q) && /ORDER BY/.test(q))
      .pop()!;
    expect(listQuery).toContain("h.status IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN')");

    mockUnsafe.mockClear();
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });
    await app.inject({ method: 'GET', url: '/hackathons?predicted=false' });
    listQuery = mockUnsafe.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((q) => /FROM hackathons h/.test(q) && /ORDER BY/.test(q))
      .pop()!;
    expect(listQuery).toContain("h.status NOT IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN')");
  });

  test('search wildcards are escaped so "%" is a literal', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 0 }];
      return [];
    });

    await app.inject({ method: 'GET', url: '/hackathons?q=50%25' });

    const params = mockUnsafe.mock.calls
      .map((c: any[]) => (c[1] || []) as any[])
      .find((p) => p.some((v) => typeof v === 'string' && v.includes('50')))!;
    expect(params).toContain('%50\\%%');
  });

  test('invalid pagination and enum values are rejected before touching the DB', async () => {
    const tooBig = await app.inject({ method: 'GET', url: '/hackathons?limit=5000' });
    expect(tooBig.statusCode).toBe(400);
    const badStatus = await app.inject({ method: 'GET', url: '/hackathons?status=MAYBE' });
    expect(badStatus.statusCode).toBe(400);
    expect(mockUnsafe).not.toHaveBeenCalled();
  });

  test('concurrent claims: exactly one winner, the loser gets a 409 naming the holder', async () => {
    let owner: string | null = null;
    let insertedClaims = 0;
    mockUnsafe.mockImplementation(async (query: string, params: any[] = []) => {
      if (/UPDATE hackathons/.test(query) && /claimed_by = \$1/.test(query)) {
        // The WHERE claimed_by IS NULL clause is the lock: only a free row matches.
        if (owner === null) {
          owner = params[0];
          return [{ id: params[1], claimed_by: params[0], claimed_at: new Date().toISOString(), assigned_to: null }];
        }
        return [];
      }
      if (/INSERT INTO lead_claims/.test(query)) {
        insertedClaims += 1;
        return [];
      }
      if (/SELECT t\.claimed_by/.test(query)) {
        return [{ claimed_by: owner, claimed_by_email: `${owner}@example.com` }];
      }
      return [];
    });

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/hackathons/${LEAD_ID}/claim`,
        headers: { 'x-test-user': 'rep-a' },
      }),
      app.inject({
        method: 'POST',
        url: `/hackathons/${LEAD_ID}/claim`,
        headers: { 'x-test-user': 'rep-b' },
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(JSON.parse(loser.body).claimed_by_email).toBe(`${owner}@example.com`);
    // Exactly one claim was recorded: the loser never wrote claim history.
    expect(insertedClaims).toBe(1);
  });

  test('re-claiming your own lead is idempotent and does not duplicate claim history', async () => {
    mockUnsafe.mockImplementation(async (query: string, params: any[] = []) => {
      if (/UPDATE hackathons/.test(query) && /claimed_by = \$1/.test(query)) return [];
      if (/SELECT t\.claimed_by/.test(query)) return [{ claimed_by: 'user-1', claimed_by_email: 'rep@example.com' }];
      return [];
    });

    const res = await app.inject({
      method: 'POST',
      url: `/hackathons/${LEAD_ID}/claim`,
      headers: { 'x-test-user': 'user-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).already_owned).toBe(true);
    expect(callsMatching(/INSERT INTO lead_claims/)).toHaveLength(0);
  });

  test('a lead claimed by another rep is 404, never a silent read', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM hackathons WHERE id = \$1 AND \(assigned_to/.test(query)) return [];
      return [];
    });

    const res = await app.inject({ method: 'GET', url: `/hackathons/${LEAD_ID}` });

    expect(res.statusCode).toBe(404);
    // The detail payload must never be assembled for a row the caller cannot read.
    expect(callsMatching(/FROM hackathon_occurrences/)).toHaveLength(0);
  });

  test('prediction endpoint reports availability honestly when nothing was modelled', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/SELECT 1 FROM hackathons WHERE id = \$1/.test(query)) return [{ '?column?': 1 }];
      return [];
    });

    const res = await app.inject({ method: 'GET', url: `/hackathons/${LEAD_ID}/prediction` });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ prediction: null, available: false });
  });

  test('export is CSV with provenance columns, not just the pretty fields', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 1 }];
      if (/SELECT/.test(query) && /FROM hackathons h/.test(query)) {
        return [{
          name: 'Smart India Hackathon', organizer_name: 'MoE', state: 'Delhi',
          contact_email: 'tpo@college.edu', prediction_basis: 'Observed 2024, 2025, 2026',
        }];
      }
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/hackathons/export' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const [header, row] = res.body.split('\n');
    expect(header).toContain('prediction_basis');
    expect(header).toContain('verification_status');
    expect(row).toContain('Smart India Hackathon');
    expect(row).toContain('Observed 2024, 2025, 2026');
  });

  test('analytics declare themselves measured so the UI never shows invented numbers', async () => {
    mockUnsafe.mockImplementation(async (query: string) => {
      if (/COUNT\(\*\)::int AS total/.test(query)) return [{ total: 7, organizers: 3 }];
      return [];
    });

    const res = await app.inject({ method: 'GET', url: '/hackathons/eda' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.measured).toBe(true);
    expect(body.total).toBe(7);
  });

  test('invalid uuid is a 400 on every id-scoped route', async () => {
    for (const url of ['/hackathons/not-a-uuid', '/hackathons/not-a-uuid/history', '/hackathons/not-a-uuid/prediction']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
    }
  });
});
