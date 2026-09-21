import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate, authorize } from '../middleware/auth';
import { logAuditEvent } from '../utils/audit';
import {
  assignEntity,
  boolParam,
  bulkAssign,
  bulkClaim,
  bulkIds,
  bulkStatus,
  canReadEntity,
  claimEntity,
  escapeLike,
  ownsEntity,
  recordActivity,
  toCsv,
  unclaimEntity,
} from '../utils/leadDomains';
import { callWorker } from '../utils/worker';

const VALID_STATUS = [
  'DISCOVERED', 'CONFIRMED', 'ANNOUNCED', 'REGISTRATION_OPEN', 'UPCOMING',
  'HISTORICAL', 'RECURRING_PATTERN', 'PREDICTED', 'LOW_CONFIDENCE_PREDICTION',
] as const;

const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(25),
  sort_by: z
    .enum(['created_at', 'event_start', 'registration_deadline', 'prize_pool',
      'confidence_score', 'completeness_score', 'name', 'organizer_name', 'state', 'status'])
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
  filter: z.string().optional(),
  status: z.enum(VALID_STATUS).optional(),
  // `predicted` intentionally separates guesses from confirmed rows.
  predicted: z.preprocess(boolParam, z.boolean().optional()),
  mode: z.enum(['online', 'offline', 'hybrid']).optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  organizer: z.string().optional(),
  event_type: z.string().optional(),
  technology: z.string().optional(),
  domain: z.string().optional(),
  source_platform: z.string().optional(),
  month: z.coerce.number().min(1).max(12).optional(),
  student_only: z.preprocess(boolParam, z.boolean().optional()),
  open_to_public: z.preprocess(boolParam, z.boolean().optional()),
  hiring_opportunities: z.preprocess(boolParam, z.boolean().optional()),
  internship_opportunities: z.preprocess(boolParam, z.boolean().optional()),
  prize_min: z.coerce.number().min(0).optional(),
  prize_max: z.coerce.number().min(0).optional(),
  registration: z.enum(['open', 'closing_soon', 'closed', 'upcoming']).optional(),
  confidence_min: z.coerce.number().min(0).max(100).optional(),
  freshness: z.enum(['fresh', 'recent', 'aging', 'stale', 'unknown']).optional(),
  contact: z.enum(['none', 'partial', 'enriched', 'verified']).optional(),
  ownership: z.enum(['unclaimed', 'claimed', 'assigned', 'mine']).optional(),
  mine: z.preprocess(boolParam, z.boolean().optional()),
  event_from: z.string().optional(),
  event_to: z.string().optional(),
});

function buildFilters(q: z.infer<typeof listSchema>, user: { id: string; role: string }) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  // `add('a = ? AND b = ?', x, y)` binds sequentially, so a value reused in one
  // condition is passed multiple times rather than sharing a placeholder index.
  const add = (template: string, ...vals: unknown[]) => {
    let sqlText = template;
    for (const value of vals) {
      values.push(value);
      sqlText = sqlText.replace('?', `$${values.length}`);
    }
    conditions.push(sqlText);
  };

  // RBAC: a rep sees owned rows plus the unclaimed pool (claim must be reachable).
  if (user.role === 'sales_rep' && q.ownership !== 'unclaimed') {
    add(
      `(h.assigned_to = ? OR h.claimed_by = ? OR (h.claimed_by IS NULL AND h.assigned_to IS NULL))`,
      user.id, user.id,
    );
  }
  if (q.mine === true || q.ownership === 'mine') {
    add(`(h.assigned_to = ? OR h.claimed_by = ?)`, user.id, user.id);
  } else if (q.ownership === 'unclaimed') {
    conditions.push(`(h.claimed_by IS NULL AND h.assigned_to IS NULL)`);
  } else if (q.ownership === 'claimed') {
    conditions.push(`(h.claimed_by IS NOT NULL)`);
  } else if (q.ownership === 'assigned') {
    conditions.push(`(h.assigned_to IS NOT NULL)`);
  }

  if (q.status) add(`h.status = ?`, q.status);
  if (q.predicted === true) {
    conditions.push(`h.status IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN')`);
  } else if (q.predicted === false) {
    conditions.push(`h.status NOT IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN')`);
  }
  if (q.mode) add(`h.mode = ?`, q.mode);
  if (q.state) add(`h.state ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.state)}%`);
  if (q.city) add(`h.city ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.city)}%`);
  if (q.organizer) add(`h.organizer_name ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.organizer)}%`);
  if (q.event_type) add(`h.event_type ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.event_type)}%`);
  if (q.technology) add(`h.technology ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.technology)}%`);
  if (q.domain) add(`h.domain ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.domain)}%`);
  if (q.source_platform) add(`h.source_platform ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.source_platform)}%`);
  if (q.month) add(`EXTRACT(MONTH FROM COALESCE(h.event_start, h.registration_start)) = ?`, q.month);
  if (q.student_only !== undefined) conditions.push(q.student_only ? `h.student_only IS TRUE` : `h.student_only IS NOT TRUE`);
  if (q.open_to_public !== undefined) conditions.push(q.open_to_public ? `h.open_to_public IS TRUE` : `h.open_to_public IS NOT TRUE`);
  if (q.hiring_opportunities !== undefined) conditions.push(q.hiring_opportunities ? `h.hiring_opportunities IS TRUE` : `h.hiring_opportunities IS NOT TRUE`);
  if (q.internship_opportunities !== undefined) conditions.push(q.internship_opportunities ? `h.internship_opportunities IS TRUE` : `h.internship_opportunities IS NOT TRUE`);
  if (q.prize_min != null) add(`h.prize_pool >= ?`, q.prize_min);
  if (q.prize_max != null) add(`h.prize_pool <= ?`, q.prize_max);
  if (q.registration === 'open') conditions.push(`h.registration_deadline >= NOW() AND h.status <> 'HISTORICAL'`);
  else if (q.registration === 'closing_soon') conditions.push(`h.registration_deadline BETWEEN NOW() AND NOW() + INTERVAL '14 days'`);
  else if (q.registration === 'closed') conditions.push(`h.registration_deadline < NOW()`);
  else if (q.registration === 'upcoming') conditions.push(`h.event_start >= NOW()`);
  if (q.confidence_min != null) add(`h.confidence_score >= ?`, q.confidence_min);
  if (q.freshness) add(`h.freshness_category = ?`, q.freshness);
  if (q.contact === 'none') conditions.push(`h.contact_email IS NULL AND h.contact_phone IS NULL AND h.contact_linkedin IS NULL`);
  else if (q.contact === 'partial') conditions.push(`(h.contact_email IS NOT NULL OR h.contact_phone IS NOT NULL OR h.contact_linkedin IS NOT NULL) AND h.verification_status <> 'verified'`);
  else if (q.contact === 'enriched') conditions.push(`(h.contact_email IS NOT NULL OR h.contact_phone IS NOT NULL OR h.contact_linkedin IS NOT NULL)`);
  else if (q.contact === 'verified') conditions.push(`h.verification_status IN ('verified','cross_verified')`);
  if (q.event_from) add(`h.event_start >= ?::timestamptz`, q.event_from);
  if (q.event_to) add(`h.event_start <= ?::timestamptz`, q.event_to);
  const text = q.q || q.filter;
  if (text) {
    const like = `%${escapeLike(text)}%`;
    add(
      `(h.name ILIKE ? ESCAPE '\\' OR h.organizer_name ILIKE ? ESCAPE '\\' OR h.city ILIKE ? ESCAPE '\\' OR h.state ILIKE ? ESCAPE '\\' OR h.technology ILIKE ? ESCAPE '\\' OR h.contact_email ILIKE ? ESCAPE '\\' OR h.contact_name ILIKE ? ESCAPE '\\')`,
      like, like, like, like, like, like, like,
    );
  }
  return { conditions, values };
}

const SORT_SQL: Record<string, string> = {
  created_at: 'h.created_at',
  event_start: 'h.event_start',
  registration_deadline: 'h.registration_deadline',
  prize_pool: 'h.prize_pool',
  confidence_score: 'h.confidence_score',
  completeness_score: 'h.completeness_score',
  name: 'h.name',
  organizer_name: 'h.organizer_name',
  state: 'h.state',
  status: 'h.status',
};

const LIST_COLUMNS = `
  h.id, h.name, h.slug, h.organizer_name, h.organizer_type, h.hackathon_url,
  h.registration_url, h.source_platform, h.event_type, h.hackathon_type, h.mode,
  h.venue, h.city, h.state, h.country, h.registration_start, h.registration_deadline,
  h.event_start, h.event_end, h.result_date, h.team_size_min, h.team_size_max,
  h.eligibility, h.student_only, h.college_only, h.open_to_public, h.prize_pool,
  h.technology, h.domain, h.themes, h.tags, h.hiring_opportunities,
  h.internship_opportunities, h.contact_name, h.contact_email, h.contact_phone,
  h.contact_linkedin, h.contact_source, h.outreach_priority, h.outreach_status,
  h.verification_status, h.verification_grade, h.source_count, h.source_urls,
  h.freshness_category, h.confidence_score, h.completeness_score, h.enrichment_status,
  h.outreach_readiness, h.status, h.occurrence_type, h.recurrence_pattern,
  h.predicted_occurrence, h.prediction_confidence, h.prediction_basis,
  h.historical_years, h.expected_month, h.expected_registration_window,
  h.claimed_by, h.claimed_at, h.assigned_to, h.first_seen_at, h.last_seen_at,
  h.created_at, h.updated_at,
  cu.email AS claimed_by_email, au.email AS assigned_to_email
`;

const LIST_FROM = `
  FROM hackathons h
  LEFT JOIN users cu ON cu.id = h.claimed_by
  LEFT JOIN users au ON au.id = h.assigned_to
`;

export const hackathonsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  async function list(req: FastifyRequest, reply: any) {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const { conditions, values } = buildFilters(q, user);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const dir = q.sort_order === 'asc' ? 'ASC' : 'DESC';
    const sortCol = SORT_SQL[q.sort_by] || 'h.created_at';
    const offset = (q.page - 1) * q.limit;
    const limitIdx = values.length + 1;

    const countRows = (await sql.unsafe(
      `SELECT COUNT(*)::int AS total ${LIST_FROM} ${where}`,
      values as any,
    )) as any[];
    const total = Number(countRows?.[0]?.total ?? 0);
    const rows = await sql.unsafe(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${where}
        ORDER BY ${sortCol} ${dir} NULLS LAST
        LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...values, q.limit, offset] as any,
    );
    return {
      data: rows,
      pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
    };
  }

  fastify.get('/', list);
  fastify.get('/search', list);

  fastify.get('/eda', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const rows = (await sql.unsafe(
      `SELECT * FROM hackathons WHERE is_active`,
    )) as any[];
    // Aggregate in SQL for exact figures rather than shipping every row to a
    // client-side calculation.
    const [totals] = (await sql.unsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'HISTORICAL')::int AS historical,
        COUNT(*) FILTER (WHERE status IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN'))::int AS predicted,
        COUNT(*) FILTER (WHERE registration_deadline >= NOW())::int AS registration_open,
        COUNT(*) FILTER (WHERE registration_deadline BETWEEN NOW() AND NOW() + INTERVAL '14 days')::int AS registration_closing_soon,
        COUNT(*) FILTER (WHERE event_start >= NOW())::int AS upcoming,
        COUNT(*) FILTER (WHERE occurrence_type = 'recurring')::int AS recurring_hackathons,
        COUNT(DISTINCT organizer_name)::int AS organizers,
        ROUND(AVG(prize_pool) FILTER (WHERE prize_pool IS NOT NULL), 2) AS average_prize_pool
      FROM hackathons WHERE is_active
    `)) as any[];
    const byState = (await sql.unsafe(
      `SELECT state AS value, COUNT(*)::int AS count FROM hackathons
        WHERE is_active AND state IS NOT NULL GROUP BY state ORDER BY count DESC LIMIT 20`,
    )) as any[];
    const byMonth = (await sql.unsafe(
      `SELECT EXTRACT(MONTH FROM COALESCE(event_start, registration_start))::int AS month,
              COUNT(*)::int AS count
         FROM hackathons WHERE is_active AND COALESCE(event_start, registration_start) IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    )) as any[];
    const byOrganizer = (await sql.unsafe(
      `SELECT organizer_name AS value, COUNT(*)::int AS count FROM hackathons
        WHERE is_active AND organizer_name IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    )) as any[];
    const byTechnology = (await sql.unsafe(
      `SELECT technology AS value, COUNT(*)::int AS count FROM hackathons
        WHERE is_active AND technology IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    )) as any[];
    const byYear = (await sql.unsafe(
      `SELECT EXTRACT(YEAR FROM COALESCE(event_start, registration_start))::int AS year,
              COUNT(*)::int AS count
         FROM hackathons WHERE is_active AND COALESCE(event_start, registration_start) IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    )) as any[];
    const byMode = (await sql.unsafe(
      `SELECT COALESCE(mode, 'unknown') AS mode, COUNT(*)::int AS count FROM hackathons
        WHERE is_active GROUP BY 1`,
    )) as any[];
    return {
      measured: true,
      total: Number(totals?.total ?? 0),
      active_rows: rows.length,
      ...totals,
      by_state: byState,
      by_month: byMonth,
      by_year: byYear,
      by_organizer: byOrganizer,
      by_technology: byTechnology,
      by_mode: byMode,
    };
  });

  fastify.get('/organizers', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const rows = await sql.unsafe(`
      SELECT h.organizer_name,
             COUNT(*)::int AS hackathon_count,
             MIN(COALESCE(h.event_start, h.registration_start)) AS first_seen_event,
             MAX(COALESCE(h.event_start, h.registration_start)) AS latest_event,
             ARRAY_AGG(DISTINCT EXTRACT(YEAR FROM COALESCE(h.event_start, h.registration_start))::int)
               FILTER (WHERE COALESCE(h.event_start, h.registration_start) IS NOT NULL) AS years,
             COUNT(DISTINCT h.state)::int AS states
        FROM hackathons h
       WHERE h.is_active AND h.organizer_name IS NOT NULL
       GROUP BY h.organizer_name
       ORDER BY hackathon_count DESC
       LIMIT 100
    `);
    return { organizers: rows };
  });

  // ---------------- bulk operations ----------------
  // A batch reports per-lead outcomes: one lead claimed by someone else must not
  // fail the other 99.
  const bulkBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

  fastify.post('/bulk-claim', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = bulkBody.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const user = req.user as { id: string; role: string };
    const result = await bulkClaim('hackathon', bulkIds(parsed.data.ids), user);
    await logAuditEvent({
      user_id: user.id, action: 'bulk_claim_hackathons', resource_type: 'hackathon',
      details: { requested: result.requested, succeeded: result.succeeded },
    });
    return result;
  });

  fastify.patch('/bulk-assign', { preValidation: [authorize(['admin'])] }, async (req, reply) => {
    // Accepts a user id or an email address (resolved server-side).
    const parsed = bulkBody
      .extend({ assigned_to: z.string().min(3).max(200).nullable() })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const user = req.user as { id: string; role: string };
    return bulkAssign('hackathon', bulkIds(parsed.data.ids), parsed.data.assigned_to, user);
  });

  fastify.patch('/bulk-status', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = bulkBody
      .extend({ field: z.enum(['outreach_status', 'status']), value: z.string().min(1).max(40) })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const user = req.user as { id: string; role: string };
    if (parsed.data.field === 'status' && !VALID_STATUS.includes(parsed.data.value as any)) {
      return reply.status(400).send({ error: 'Invalid status value' });
    }
    const result = await bulkStatus(
      'hackathon', bulkIds(parsed.data.ids), parsed.data.field, parsed.data.value, user,
    );
    return result;
  });

  fastify.get('/export', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const { conditions, values } = buildFilters(q, user);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = (await sql.unsafe(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${where} ORDER BY h.created_at DESC LIMIT 10000`,
      values as any,
    )) as Array<Record<string, unknown>>;
    const columns = ['name', 'organizer_name', 'status', 'mode', 'city', 'state',
      'event_start', 'registration_deadline', 'prize_pool', 'technology', 'hackathon_url',
      'contact_name', 'contact_email', 'contact_phone', 'contact_linkedin',
      'verification_status', 'confidence_score', 'outreach_readiness', 'outreach_score',
      'outreach_priority', 'predicted_occurrence', 'prediction_confidence', 'prediction_basis'];
    const csv = toCsv(rows, columns);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="hackathons.csv"');
    return csv;
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
    const id = idParse.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    if (!(await canReadEntity(sql, 'hackathon', id, user))) {
      return reply.status(404).send({ error: 'Hackathon not found' });
    }
    const rows = await sql.unsafe(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE h.id = $1`, [id]);
    if (!rows || rows.length === 0) return reply.status(404).send({ error: 'Hackathon not found' });
    const [occurrences, contacts, sources, predictions, activity, notes] = await Promise.all([
      sql.unsafe(`SELECT * FROM hackathon_occurrences WHERE hackathon_id = $1 ORDER BY year DESC`, [id]),
      sql.unsafe(`SELECT * FROM hackathon_contacts WHERE hackathon_id = $1 ORDER BY priority, created_at DESC`, [id]),
      sql.unsafe(`SELECT id, source_platform, source_url, extraction_method, confidence, fetched_at FROM hackathon_sources WHERE hackathon_id = $1 ORDER BY fetched_at DESC`, [id]),
      sql.unsafe(`SELECT * FROM hackathon_predictions WHERE hackathon_id = $1 ORDER BY generated_at DESC LIMIT 10`, [id]),
      sql.unsafe(`SELECT a.*, u.email AS actor_email FROM lead_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.domain = 'hackathon' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [id]),
      sql.unsafe(`SELECT n.*, u.email AS author_email FROM lead_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.domain = 'hackathon' AND n.entity_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [id]),
    ]);
    return {
      hackathon: rows[0],
      occurrences,
      contacts,
      sources,
      predictions,
      activity,
      notes,
    };
  });

  fastify.get<{ Params: { id: string } }>('/:id/history', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
      return reply.status(404).send({ error: 'Hackathon not found' });
    }
    const occurrences = await sql.unsafe(
      `SELECT * FROM hackathon_occurrences WHERE hackathon_id = $1 ORDER BY year ASC`,
      [idParse.data],
    );
    return { occurrences, historical_years: occurrences.map((o: any) => o.year) };
  });

  fastify.get<{ Params: { id: string } }>('/:id/prediction', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
      return reply.status(404).send({ error: 'Hackathon not found' });
    }
    const rows = await sql.unsafe(
      `SELECT * FROM hackathon_predictions WHERE hackathon_id = $1 ORDER BY generated_at DESC LIMIT 1`,
      [idParse.data],
    );
    // Nothing is returned when no prediction exists: absence is the honest answer,
    // never a fabricated "likely" date.
    return { prediction: rows?.[0] || null, available: Boolean(rows && rows.length) };
  });

  fastify.get<{ Params: { id: string } }>('/:id/contacts', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
      return reply.status(404).send({ error: 'Hackathon not found' });
    }
    const contacts = await sql.unsafe(
      `SELECT * FROM hackathon_contacts WHERE hackathon_id = $1 ORDER BY priority, created_at DESC`,
      [idParse.data],
    );
    return { contacts };
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/claim',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
      const user = req.user as { id: string; role: string };
      const result = await claimEntity('hackathon', idParse.data, user);
      if (result.status === 'missing') return reply.status(404).send({ error: 'Hackathon not found' });
      if (result.status === 'taken') {
        return reply.status(409).send({
          error: 'Hackathon was already claimed by another member.',
          claimed_by: (result.row as any)?.claimed_by,
          claimed_by_email: (result.row as any)?.claimed_by_email,
        });
      }
      await logAuditEvent({
        user_id: user.id, action: 'claim_hackathon', resource_type: 'hackathon',
        resource_id: idParse.data, details: { status: result.status },
      });
      return { hackathon: result.row, already_owned: result.status === 'already_owned' };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/enrich',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
        return reply.status(404).send({ error: 'Hackathon not found' });
      }
      const result = await callWorker(`/intelligence/hackathons/${idParse.data}/enrich`, {
        method: 'POST',
        body: { triggered_by: user.id },
      });
      await recordActivity('hackathon', idParse.data, 'enrichment_requested', user.id, null);
      return reply.status(result.ok ? 202 : 502).send(result.data);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/unclaim',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
      const user = req.user as { id: string; role: string };
      const ok = await unclaimEntity('hackathon', idParse.data, user);
      if (!ok) return reply.status(404).send({ error: 'Not claimed by you, or not found' });
      return { unclaimed: true };
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/assign',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      const body = z.object({ assigned_to: z.string().uuid().nullable().optional() }).safeParse(req.body || {});
      if (!idParse.success || !body.success) return reply.status(400).send({ error: 'Invalid request' });
      const user = req.user as { id: string; role: string };
      const row = await assignEntity('hackathon', idParse.data, body.data.assigned_to ?? null, user);
      if (!row) return reply.status(400).send({ error: 'Hackathon or user not found' });
      return { hackathon: row };
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/outreach',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      const body = z.object({ outreach_status: z.string().min(1).max(40) }).safeParse(req.body || {});
      if (!idParse.success || !body.success) return reply.status(400).send({ error: 'Invalid request' });
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      if (!(await ownsEntity(sql, 'hackathon', idParse.data, user))) {
        return reply.status(404).send({ error: 'Hackathon not found' });
      }
      const rows = await sql.unsafe(
        `UPDATE hackathons SET outreach_status = $1, updated_at = NOW() WHERE id = $2
          RETURNING id, outreach_status`,
        [body.data.outreach_status, idParse.data],
      );
      await recordActivity('hackathon', idParse.data, 'outreach_status', user.id, {
        outreach_status: body.data.outreach_status,
      });
      return { hackathon: rows[0] };
    },
  );

  fastify.get<{ Params: { id: string } }>('/:id/activity', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid hackathon id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
      return reply.status(404).send({ error: 'Hackathon not found' });
    }
    const [activity, claims, assignments] = await Promise.all([
      sql.unsafe(
        `SELECT a.*, u.email AS actor_email FROM lead_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.domain = 'hackathon' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
        [idParse.data],
      ),
      sql.unsafe(`SELECT * FROM lead_claims WHERE domain = 'hackathon' AND entity_id = $1 ORDER BY claimed_at DESC`, [idParse.data]),
      sql.unsafe(`SELECT * FROM lead_assignments WHERE domain = 'hackathon' AND entity_id = $1 ORDER BY created_at DESC`, [idParse.data]),
    ]);
    return { activity, claims, assignments };
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/notes',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      const body = z.object({ body: z.string().min(1).max(4000) }).safeParse(req.body || {});
      if (!idParse.success || !body.success) return reply.status(400).send({ error: 'Invalid request' });
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      if (!(await canReadEntity(sql, 'hackathon', idParse.data, user))) {
        return reply.status(404).send({ error: 'Hackathon not found' });
      }
      const rows = await sql.unsafe(
        `INSERT INTO lead_notes (domain, entity_id, body, author_id)
         VALUES ('hackathon', $1, $2, $3) RETURNING *`,
        [idParse.data, body.data.body, user.id],
      );
      await recordActivity('hackathon', idParse.data, 'note_added', user.id, null);
      return { note: rows[0] };
    },
  );
};
