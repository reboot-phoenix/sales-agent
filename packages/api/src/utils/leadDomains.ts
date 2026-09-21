import { getDB } from './db';

/**
 * Shared ownership/claim/activity helpers for the hackathon + college domains.
 *
 * Ownership is stored per-domain on the entity table itself (claimed_by /
 * assigned_to), *not* in a polymorphic table, so the atomic
 * `UPDATE ... WHERE claimed_by IS NULL` remains the single writer that can win a
 * race. History lives in the generic lead_claims / lead_assignments / lead_activity
 * tables for audit only.
 */

export type LeadDomain = 'job' | 'hackathon' | 'college';

// Domain = security boundary: the table name is interpolated into SQL, so it must
// only ever come from this closed map, never from user input.
export const DOMAIN_TABLE: Record<'hackathon' | 'college', string> = {
  hackathon: 'hackathons',
  college: 'colleges',
};

export type Sql = ReturnType<typeof getDB>;
export interface AuthUser {
  id: string;
  role: string;
}

export function entityTable(domain: 'hackathon' | 'college'): string {
  const table = DOMAIN_TABLE[domain];
  if (!table) throw new Error(`unknown domain ${domain}`);
  return table;
}

/** Owner-only mutation guard (admin bypasses). */
export async function ownsEntity(
  sql: Sql,
  domain: 'hackathon' | 'college',
  id: string,
  user: AuthUser,
): Promise<boolean> {
  const table = entityTable(domain);
  if (user.role === 'admin') {
    const rows = await sql.unsafe(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    return rows.length > 0;
  }
  const rows = await sql.unsafe(
    `SELECT 1 FROM ${table} WHERE id = $1 AND (assigned_to = $2 OR claimed_by = $2)`,
    [id, user.id],
  );
  return rows.length > 0;
}

/** Read guard: owned rows plus the unclaimed pool (so a rep can inspect before claiming). */
export async function canReadEntity(
  sql: Sql,
  domain: 'hackathon' | 'college',
  id: string,
  user: AuthUser,
): Promise<boolean> {
  const table = entityTable(domain);
  if (user.role === 'admin') {
    const rows = await sql.unsafe(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    return rows.length > 0;
  }
  const rows = await sql.unsafe(
    `SELECT 1 FROM ${table} WHERE id = $1 AND (assigned_to = $2 OR claimed_by = $2
       OR (claimed_by IS NULL AND assigned_to IS NULL))`,
    [id, user.id],
  );
  return rows.length > 0;
}

export async function recordActivity(
  domain: LeadDomain,
  entityId: string,
  action: string,
  actorId: string | null,
  details?: Record<string, unknown> | null,
): Promise<void> {
  const sql = getDB();
  await sql.unsafe(
    `INSERT INTO lead_activity (domain, entity_id, action, actor_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [domain, entityId, action, actorId, details ? JSON.stringify(details) : null],
  );
}

/**
 * Atomic claim. Returns 'claimed' | 'already_owned' | 'taken' | 'missing'.
 * The UPDATE's WHERE clause is the lock: exactly one concurrent caller can match.
 */
export async function claimEntity(
  domain: 'hackathon' | 'college',
  id: string,
  user: AuthUser,
): Promise<{ status: 'claimed' | 'already_owned' | 'taken' | 'missing'; row?: any }> {
  const sql = getDB();
  const table = entityTable(domain);
  const updated = await sql.unsafe(
    `UPDATE ${table}
        SET claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
      WHERE id = $2 AND claimed_by IS NULL
      RETURNING id, claimed_by, claimed_at, assigned_to`,
    [user.id, id],
  );
  if (updated && updated.length > 0) {
    await sql.unsafe(
      `INSERT INTO lead_claims (domain, entity_id, claimed_by, claimed_at) VALUES ($1,$2,$3,NOW())`,
      [domain, id, user.id],
    );
    await recordActivity(domain, id, 'claim', user.id, { claimed_by: user.id });
    return { status: 'claimed', row: updated[0] };
  }
  const existing = await sql.unsafe(
    `SELECT t.claimed_by, u.email AS claimed_by_email
       FROM ${table} t LEFT JOIN users u ON u.id = t.claimed_by WHERE t.id = $1`,
    [id],
  );
  if (!existing || existing.length === 0) return { status: 'missing' };
  const owner = existing[0] as unknown as { claimed_by: string | null; claimed_by_email: string | null };
  if (owner.claimed_by === user.id) return { status: 'already_owned', row: owner };
  return { status: 'taken', row: owner };
}

export async function unclaimEntity(
  domain: 'hackathon' | 'college',
  id: string,
  user: AuthUser,
): Promise<boolean> {
  const sql = getDB();
  const table = entityTable(domain);
  const rows = await sql.unsafe(
    `UPDATE ${table} SET claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND ($2 = 'admin' OR claimed_by = $3)
      RETURNING id`,
    [id, user.role, user.id],
  );
  if (!rows || rows.length === 0) return false;
  await sql.unsafe(
    `UPDATE lead_claims SET released_at = NOW()
      WHERE id = (SELECT id FROM lead_claims WHERE domain = $1 AND entity_id = $2
                   ORDER BY claimed_at DESC LIMIT 1)`,
    [domain, id],
  );
  await recordActivity(domain, id, 'unclaim', user.id, null);
  return true;
}

export async function assignEntity(
  domain: 'hackathon' | 'college',
  id: string,
  assignedTo: string | null,
  user: AuthUser,
): Promise<any | null> {
  const sql = getDB();
  const table = entityTable(domain);
  if (assignedTo) {
    const target = await sql.unsafe(`SELECT id FROM users WHERE id = $1`, [assignedTo]);
    if (!target || target.length === 0) return null;
  }
  const rows = await sql.unsafe(
    `UPDATE ${table} SET assigned_to = $1, updated_at = NOW() WHERE id = $2
      RETURNING id, assigned_to`,
    [assignedTo, id],
  );
  if (!rows || rows.length === 0) return null;
  await sql.unsafe(
    `INSERT INTO lead_assignments (domain, entity_id, assigned_to, assigned_by)
     VALUES ($1,$2,$3,$4)`,
    [domain, id, assignedTo, user.id],
  );
  await recordActivity(domain, id, 'assign', user.id, { assigned_to: assignedTo });
  return rows[0];
}

export interface BulkResult {
  requested: number;
  succeeded: number;
  skipped: { id: string; reason: string }[];
}

/** Cap on one bulk request: a bigger batch should be a job, not a request. */
export const BULK_LIMIT = 100;

/**
 * Claim many leads, reporting per-lead outcomes instead of failing the batch.
 *
 * A bulk action is not a transaction across rows: if one lead was claimed by
 * someone else a moment ago, the rest must still be claimed and the caller must
 * be told exactly which one was not.
 */
export async function bulkClaim(
  domain: 'hackathon' | 'college',
  ids: string[],
  user: AuthUser,
): Promise<BulkResult> {
  // claimEntity already records per-lead activity and claim history, so a bulk
  // wrapper must not write a second, vaguer entry on top of it.
  return applyEach(ids, async (id) => {
    const outcome = await claimEntity(domain, id, user);
    if (outcome.status === 'claimed' || outcome.status === 'already_owned') {
      return { ok: true, reason: outcome.status };
    }
    if (outcome.status === 'taken') {
      const owner = (outcome.row as any)?.claimed_by_email || 'another member';
      return { ok: false, reason: `already claimed by ${owner}` };
    }
    return { ok: false, reason: 'not found' };
  });
}

/**
 * Assign (or unassign) many leads. Admin-only, matching the single-row route.
 *
 * Accepts a user id *or* an email address: an operator working from a team list
 * knows their colleague's address, and making them resolve a uuid by hand is how
 * reassignments go to the wrong person. An unknown address is a hard error rather
 * than a silent no-op.
 */
export async function bulkAssign(
  domain: 'hackathon' | 'college',
  ids: string[],
  assignedTo: string | null,
  user: AuthUser,
): Promise<BulkResult> {
  if (user.role !== 'admin') {
    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  }
  let targetId = assignedTo;
  if (assignedTo && assignedTo.includes('@')) {
    const sql = getDB();
    const rows = await sql.unsafe('SELECT id FROM users WHERE lower(email) = lower($1)', [assignedTo]);
    if (rows.length === 0) {
      throw Object.assign(new Error(`no user with email ${assignedTo}`), { statusCode: 400 });
    }
    // postgres.js types rows as `Row & Iterable<Row>`; go through `unknown`
    // because the generic row type has no known keys.
    targetId = String((rows[0] as unknown as { id: string }).id);
  }
  const resolved = targetId;
  return applyEach(ids, async (id) => {
    const row = await assignEntity(domain, id, resolved, user);
    return row ? { ok: true, reason: resolved ?? 'unassigned' } : { ok: false, reason: 'lead or user not found' };
  });
}

/**
 * Bulk status change, scoped to the caller's own rows (admins bypass).
 *
 * `column` is chosen from a closed allow-list by the caller and validated here,
 * because it is interpolated into SQL.
 */
const BULK_STATUS_COLUMNS: Record<'hackathon' | 'college', Record<string, string>> = {
  hackathon: { outreach_status: 'outreach_status', status: 'status' },
  college: { outreach_status: 'outreach_status', enrichment_status: 'enrichment_status' },
};

/** Columns a bulk request may never write, even if a caller asks nicely. */
export const BULK_STATUS_ALLOWED = BULK_STATUS_COLUMNS;

export async function bulkStatus(
  domain: 'hackathon' | 'college',
  ids: string[],
  field: string,
  value: string,
  user: AuthUser,
): Promise<BulkResult> {
  const column = BULK_STATUS_COLUMNS[domain][field];
  if (!column) {
    throw Object.assign(new Error(`unsupported bulk field ${field} for ${domain}`), { statusCode: 400 });
  }
  const sql = getDB();
  const table = entityTable(domain);
  const ownerClause = user.role === 'admin' ? '' : ' AND (assigned_to = $3 OR claimed_by = $3)';
  const params: unknown[] = [value, ids, user.id];
  if (user.role === 'admin') params.pop();
  const rows = (await sql.unsafe(
    `UPDATE ${table} SET ${column} = $1, updated_at = NOW()
      WHERE id = ANY($2::uuid[])${ownerClause}
      RETURNING id`,
    params as any,
  )) as any[];
  const updated = new Set(rows.map((row) => String(row.id)));
  const skipped = ids.filter((id) => !updated.has(id)).map((id) => ({ id, reason: 'not owned or not found' }));
  // Audit the batch on the leads it actually touched, so the trail names real
  // entities rather than an arbitrary first id.
  for (const id of updated) {
    await recordActivity(domain, id, `bulk_${field}`, user.id, { value }).catch(() => undefined);
  }
  return { requested: ids.length, succeeded: updated.size, skipped };
}

/** Run an action per id, never letting one failure abort the batch. */
export async function applyEach(
  ids: string[],
  action: (id: string) => Promise<{ ok: boolean; reason: string }>,
): Promise<BulkResult> {
  const skipped: { id: string; reason: string }[] = [];
  let succeeded = 0;
  for (const id of ids) {
    const outcome = await action(id);
    if (outcome.ok) succeeded += 1;
    else skipped.push({ id, reason: outcome.reason });
  }
  return { requested: ids.length, succeeded, skipped };
}

/** Cap + de-duplicate an id list from a request body. */
export function bulkIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const unique = new Set<string>();
  for (const id of list) {
    if (typeof id !== 'string') continue;
    unique.add(id);
    if (unique.size >= BULK_LIMIT) break;
  }
  return [...unique];
}

/** Tri-state boolean query parsing: `Boolean("false")` is true, so parse words. */
export function boolParam(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return undefined;
}

/** Escape LIKE wildcards so a search for "50%" does not become a wildcard. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(',')).join('\n');
  return `${header}\n${body}`;
}
