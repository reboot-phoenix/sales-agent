import { FastifyInstance } from 'fastify';

jest.mock('../src/middleware/auth', () => ({
  authenticate: jest.fn(async (req: any, _reply: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', role: 'admin' };
  }),
  authorize: () => jest.fn(async (req: any, _reply: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', role: 'admin' };
  }),
}));

jest.mock('../src/utils/db', () => ({
  getDB: () => ({ unsafe: mockSqlUnsafe }),
}));

jest.mock('../src/utils/redis', () => ({
  getRedis: () => ({ lpush: jest.fn() }),
}));

jest.mock('../src/utils/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/sse', () => ({
  publishSSE: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/scoring', () => ({
  recomputeLeadScore: jest.fn(),
}));

const mockSqlUnsafe = jest.fn();

async function whereClause(query: string): Promise<string> {
  mockSqlUnsafe.mockReset();
  mockSqlUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*)')) return [{ total: '0' }];
    return [];
  });
  const fastify = (require('fastify') as () => FastifyInstance)();
  const { leadsRoutes } = require('../src/routes/leads');
  fastify.register(leadsRoutes, { prefix: '/leads' });
  await fastify.ready();
  await fastify.inject({ method: 'GET', url: `/leads${query}` });
  await fastify.close();
  // The COUNT query carries no SELECT list, so any column match here proves a
  // real WHERE condition (not the shared select columns).
  const countCall = mockSqlUnsafe.mock.calls.find((c) => String(c[0]).includes('COUNT(*)'));
  const sql = String(countCall?.[0] ?? '');
  return sql.slice(sql.indexOf('WHERE'));
}

describe('Leads API - filter coverage', () => {
  test('contact=none scopes to leads without an HR contact', async () => {
    expect(await whereClause('?contact=none')).toMatch(/l\.hr_contact_id IS NULL/);
  });

  test('contact=partial requires a contact row but no email or mobile', async () => {
    const where = await whereClause('?contact=partial');
    expect(where).toMatch(/personal_email/);
    expect(where).toMatch(/personal_mobile/);
  });

  test('contact=enriched requires an email or mobile', async () => {
    const where = await whereClause('?contact=enriched');
    expect(where).toMatch(/personal_email/);
    expect(where).toMatch(/personal_mobile/);
  });

  test('contact=verified uses verification status', async () => {
    const where = await whereClause('?contact=verified');
    expect(where).toMatch(/email_status/);
    expect(where).toMatch(/whatsapp_status/);
  });

  test('freshness filters on the stored category', async () => {
    const where = await whereClause('?freshness=fresh');
    expect(where).toMatch(/freshness_category/);
  });

  test('global search covers HR name, email, mobile, source and city', async () => {
    const where = await whereClause('?filter=priya');
    expect(where).toMatch(/hc\.full_name/);
    expect(where).toMatch(/personal_email/);
    expect(where).toMatch(/personal_mobile/);
    expect(where).toMatch(/jp\.source_site/);
    expect(where).toMatch(/jp\.city/);
  });
});
