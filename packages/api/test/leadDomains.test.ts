import { boolParam, escapeLike, recordActivity, toCsv } from '../src/utils/leadDomains';

/**
 * Pure helpers that every domain route relies on. These are the small places
 * where a subtle bug becomes a data-integrity bug (a wildcard search matching
 * everything, "false" parsed as true), so they are tested directly.
 */

jest.mock('../src/utils/db', () => ({ getDB: () => ({ unsafe: mockUnsafe }) }));
const mockUnsafe = jest.fn();

describe('boolParam', () => {
  test('parses words, not just truthiness', () => {
    expect(boolParam('true')).toBe(true);
    expect(boolParam('1')).toBe(true);
    expect(boolParam('yes')).toBe(true);
    // Boolean('false') === true — the classic query-string trap.
    expect(boolParam('false')).toBe(false);
    expect(boolParam('0')).toBe(false);
    expect(boolParam('no')).toBe(false);
  });

  test('absent or unparseable stays undefined so the filter is simply omitted', () => {
    expect(boolParam(undefined)).toBeUndefined();
    expect(boolParam(null)).toBeUndefined();
    expect(boolParam('')).toBeUndefined();
    expect(boolParam('maybe')).toBeUndefined();
  });
});

describe('escapeLike', () => {
  test('escapes wildcards so user input cannot widen a search', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('C:\\Users')).toBe('C:\\\\Users');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('toCsv', () => {
  test('quotes separators, quotes and newlines; keeps nulls empty', () => {
    const csv = toCsv(
      [{ name: 'A, Inc', note: 'say "hi"', body: 'line1\nline2', missing: null }],
      ['name', 'note', 'body', 'missing'],
    );
    const [header, row] = csv.split('\n').length > 2 ? [csv.split('\n')[0], csv.split('\n').slice(1).join('\n')] : csv.split('\n');
    expect(header).toBe('name,note,body,missing');
    expect(row).toContain('"A, Inc"');
    expect(row).toContain('"say ""hi"""');
    expect(row).toContain('"line1\nline2"');
    expect(csv.endsWith(',')).toBe(true);
  });

  test('serializes objects rather than emitting [object Object]', () => {
    const csv = toCsv([{ themes: ['ai', 'web3'] }], ['themes']);
    expect(csv).toContain('"[""ai"",""web3""]"');
  });
});

describe('recordActivity', () => {
  test('journals the domain and entity so one timeline never bleeds into another', async () => {
    mockUnsafe.mockReset();
    mockUnsafe.mockResolvedValue([]);

    await recordActivity('college', 'abc', 'claim', 'user-1', { claimed_by: 'user-1' });

    const [sql, params] = mockUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO lead_activity');
    expect(params[0]).toBe('college');
    expect(params[1]).toBe('abc');
    expect(params[2]).toBe('claim');
    expect(JSON.parse(params[4])).toEqual({ claimed_by: 'user-1' });
  });

  test('stores null details as null, not as the string "null"', async () => {
    mockUnsafe.mockReset();
    mockUnsafe.mockResolvedValue([]);

    await recordActivity('hackathon', 'abc', 'unclaim', 'user-1');

    expect(mockUnsafe.mock.calls[0][1][4]).toBeNull();
  });
});
