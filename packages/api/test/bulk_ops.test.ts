/**
 * Bulk operations must be partial-success by design: a rep selecting 50 leads
 * expects the 49 they may act on to go through, and to be told exactly which one
 * did not and why. Nothing here may silently swallow a refusal.
 */
const unsafe = jest.fn(async () => []);

jest.mock('../src/utils/db', () => ({ getDB: () => ({ unsafe }) }));

import { BULK_LIMIT, bulkIds, bulkStatus, bulkAssign, applyEach } from '../src/utils/leadDomains';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
const REP = { id: '22222222-2222-4222-8222-222222222222', role: 'sales_rep' };

describe('id list hygiene', () => {
  it('de-duplicates and caps the batch', () => {
    const ids = Array.from({ length: BULK_LIMIT + 50 }, (_, i) => `id-${i}`);
    const result = bulkIds(ids);
    expect(result).toHaveLength(BULK_LIMIT);
    expect(new Set(result).size).toBe(result.length);
  });

  it('drops non-string entries instead of stringifying whatever arrived', () => {
    expect(bulkIds(['a', 5, null, { id: 'x' }, 'b'])).toEqual(['a', 'b']);
    expect(bulkIds('not-an-array')).toEqual([]);
  });
});

describe('applyEach', () => {
  it('records a reason for every id that did not succeed', async () => {
    const result = await applyEach(['a', 'b', 'c'], async (id) =>
      id === 'b' ? { ok: false, reason: 'taken' } : { ok: true, reason: 'ok' },
    );
    expect(result).toEqual({ requested: 3, succeeded: 2, skipped: [{ id: 'b', reason: 'taken' }] });
  });
});

describe('bulkStatus', () => {
  beforeEach(() => unsafe.mockClear());

  it('refuses a field that is not in the closed allow-list', async () => {
    await expect(bulkStatus('college', ['a'], 'name', 'x', ADMIN)).rejects.toThrow(/unsupported bulk field/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('scopes a non-admin update to rows they own', async () => {
    await bulkStatus('college', ['a'], 'enrichment_status', 'NEEDS_ENRICHMENT', REP);
    const [sql, params] = unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/assigned_to = \$3 OR claimed_by = \$3/);
    expect(params).toContain(REP.id);
  });

  it('lets an admin update any row without binding an unused owner parameter', async () => {
    await bulkStatus('hackathon', ['a'], 'outreach_status', 'contacted', ADMIN);
    const [sql, params] = unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).not.toMatch(/\$3/);
    expect(params).toHaveLength(2);
  });

  it('reports rows the caller could not touch', async () => {
    unsafe.mockResolvedValueOnce([{ id: 'a' }] as any);
    const result = await bulkStatus('college', ['a', 'b'], 'outreach_status', 'contacted', REP);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toEqual([{ id: 'b', reason: 'not owned or not found' }]);
  });
});

describe('bulkAssign', () => {
  it('is admin-only, matching the single-row assign route', async () => {
    await expect(bulkAssign('college', ['a'], null, REP)).rejects.toMatchObject({ statusCode: 403 });
  });
});
