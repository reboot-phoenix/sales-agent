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

const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(25),
  sort_by: z
    .enum(['created_at', 'name', 'state', 'district', 'city', 'completeness_score',
      'confidence_score', 'nirf_rank', 'enrichment_status'])
    .default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().optional(),
  filter: z.string().optional(),
  state: z.string().optional(),
  district: z.string().optional(),
  city: z.string().optional(),
  institution_type: z.string().optional(),
  ownership: z.string().optional(),
  accreditation: z.string().optional(),
  naac_grade: z.string().optional(),
  autonomous: z.preprocess(boolParam, z.boolean().optional()),
  is_public: z.preprocess(boolParam, z.boolean().optional()),
  aicte_approved: z.preprocess(boolParam, z.boolean().optional()),
  nirf_ranked: z.preprocess(boolParam, z.boolean().optional()),
  website: z.preprocess(boolParam, z.boolean().optional()),
  has_tpo: z.preprocess(boolParam, z.boolean().optional()),
  has_principal: z.preprocess(boolParam, z.boolean().optional()),
  enrichment_status: z.enum(['NEW', 'NORMALIZED', 'ENRICHING', 'ENRICHED', 'NEEDS_ENRICHMENT', 'FAILED']).optional(),
  outreach_readiness: z
    .enum(['OUTREACH_READY', 'PARTIALLY_ENRICHED', 'NEEDS_ENRICHMENT', 'INSUFFICIENT_DATA'])
    .optional(),
  contact: z.enum(['none', 'partial', 'enriched', 'verified']).optional(),
  freshness: z.enum(['fresh', 'recent', 'aging', 'stale', 'unknown']).optional(),
  confidence_min: z.coerce.number().min(0).max(100).optional(),
  ownership_state: z.enum(['unclaimed', 'claimed', 'assigned', 'mine']).optional(),
  mine: z.preprocess(boolParam, z.boolean().optional()),
});

export const collegesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  async function list(req: FastifyRequest, reply: any) {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
    }
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (template: string, ...vals: unknown[]) => {
      let text = template;
      for (const value of vals) {
        values.push(value);
        text = text.replace('?', `$${values.length}`);
      }
      conditions.push(text);
    };

    if (user.role === 'sales_rep' && q.ownership_state !== 'unclaimed') {
      add(`(c.assigned_to = ? OR c.claimed_by = ? OR (c.claimed_by IS NULL AND c.assigned_to IS NULL))`, user.id, user.id);
    }
    if (q.mine === true || q.ownership_state === 'mine') {
      add(`(c.assigned_to = ? OR c.claimed_by = ?)`, user.id, user.id);
    } else if (q.ownership_state === 'unclaimed') {
      conditions.push(`(c.claimed_by IS NULL AND c.assigned_to IS NULL)`);
    } else if (q.ownership_state === 'claimed') {
      conditions.push(`(c.claimed_by IS NOT NULL)`);
    } else if (q.ownership_state === 'assigned') {
      conditions.push(`(c.assigned_to IS NOT NULL)`);
    }

    if (q.state) add(`c.state ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.state)}%`);
    if (q.district) add(`c.district ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.district)}%`);
    if (q.city) add(`c.city ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.city)}%`);
    if (q.institution_type) add(`c.institution_type ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.institution_type)}%`);
    if (q.ownership) add(`c.ownership ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.ownership)}%`);
    if (q.accreditation) add(`c.accreditation ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.accreditation)}%`);
    if (q.naac_grade) add(`c.naac_grade ILIKE ? ESCAPE '\\'`, `%${escapeLike(q.naac_grade)}%`);
    if (q.autonomous !== undefined) conditions.push(q.autonomous ? `c.autonomous IS TRUE` : `c.autonomous IS NOT TRUE`);
    if (q.is_public !== undefined) conditions.push(q.is_public ? `c.is_public IS TRUE` : `c.is_public IS NOT TRUE`);
    if (q.aicte_approved !== undefined) conditions.push(q.aicte_approved ? `c.aicte_approved IS TRUE` : `c.aicte_approved IS NOT TRUE`);
    if (q.nirf_ranked !== undefined) conditions.push(q.nirf_ranked ? `c.nirf_rank IS NOT NULL` : `c.nirf_rank IS NULL`);
    if (q.website !== undefined) conditions.push(q.website ? `c.website_url IS NOT NULL` : `c.website_url IS NULL`);
    if (q.has_tpo !== undefined) {
      conditions.push(q.has_tpo
        ? `(c.tpo_name IS NOT NULL OR c.tpo_email IS NOT NULL OR EXISTS (
             SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id
              AND cc.role_category IN ('tpo','placement_head','placement_cell')))`
        : `(c.tpo_name IS NULL AND c.tpo_email IS NULL AND NOT EXISTS (
             SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id
              AND cc.role_category IN ('tpo','placement_head','placement_cell')))`);
    }
    if (q.has_principal !== undefined) {
      conditions.push(q.has_principal
        ? `(c.principal_name IS NOT NULL OR EXISTS (
             SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id AND cc.role_category = 'principal'))`
        : `(c.principal_name IS NULL AND NOT EXISTS (
             SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id AND cc.role_category = 'principal'))`);
    }
    if (q.enrichment_status) add(`c.enrichment_status = ?`, q.enrichment_status);
    if (q.outreach_readiness) add(`c.outreach_readiness = ?`, q.outreach_readiness);
    if (q.freshness) add(`c.freshness_category = ?`, q.freshness);
    if (q.confidence_min != null) add(`c.confidence_score >= ?`, q.confidence_min);
    if (q.contact === 'none') conditions.push(`NOT EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id)`);
    else if (q.contact === 'partial') conditions.push(`EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id) AND NOT EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id AND cc.verification_status IN ('verified','cross_verified'))`);
    else if (q.contact === 'enriched') conditions.push(`EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id AND (cc.email IS NOT NULL OR cc.phone IS NOT NULL OR cc.linkedin_url IS NOT NULL))`);
    else if (q.contact === 'verified') conditions.push(`EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id AND cc.verification_status IN ('verified','cross_verified'))`);
    const text = q.q || q.filter;
    if (text) {
      const like = `%${escapeLike(text)}%`;
      add(
        `(c.name ILIKE ? ESCAPE '\\' OR c.official_name ILIKE ? ESCAPE '\\' OR c.city ILIKE ? ESCAPE '\\'
          OR c.district ILIKE ? ESCAPE '\\' OR c.state ILIKE ? ESCAPE '\\' OR c.website_url ILIKE ? ESCAPE '\\'
          OR c.official_email ILIKE ? ESCAPE '\\' OR c.tpo_name ILIKE ? ESCAPE '\\' OR c.principal_name ILIKE ? ESCAPE '\\')`,
        like, like, like, like, like, like, like, like, like,
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const dir = q.sort_order === 'asc' ? 'ASC' : 'DESC';
    const sortMap: Record<string, string> = {
      created_at: 'c.created_at', name: 'c.name', state: 'c.state', district: 'c.district',
      city: 'c.city', completeness_score: 'c.completeness_score',
      confidence_score: 'c.confidence_score', nirf_rank: 'c.nirf_rank',
      enrichment_status: 'c.enrichment_status',
    };
    const sortCol = sortMap[q.sort_by] || 'c.created_at';
    const offset = (q.page - 1) * q.limit;
    const limitIdx = values.length + 1;

    const countRows = (await sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM colleges c ${where}`,
      values as any,
    )) as any[];
    const total = Number(countRows?.[0]?.total ?? 0);
    const rows = await sql.unsafe(
      `SELECT c.*,
              cu.email AS claimed_by_email, au.email AS assigned_to_email,
              (SELECT COUNT(*)::int FROM college_contacts cc WHERE cc.college_id = c.id) AS contacts_count,
              (SELECT COUNT(*)::int FROM college_contacts cc WHERE cc.college_id = c.id
                 AND cc.role_category IN ('tpo','placement_head','placement_cell')) AS tpo_contact_count
         FROM colleges c
         LEFT JOIN users cu ON cu.id = c.claimed_by
         LEFT JOIN users au ON au.id = c.assigned_to
         ${where}
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

  fastify.get('/states', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const rows = await sql.unsafe(`
      SELECT COALESCE(c.state, 'unknown') AS state, COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE c.enrichment_status = 'ENRICHED')::int AS enriched,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id
                AND cc.role_category IN ('tpo','placement_head','placement_cell')))::int AS with_tpo
        FROM colleges c
       WHERE c.is_active
       GROUP BY COALESCE(c.state, 'unknown')
       ORDER BY total DESC
    `);
    return { states: rows };
  });

  fastify.get('/eda', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const [totals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT state)::int AS states_covered,
             COUNT(DISTINCT district)::int AS districts_covered,
             COUNT(*) FILTER (WHERE website_url IS NOT NULL)::int AS with_website,
             COUNT(*) FILTER (WHERE official_email IS NOT NULL)::int AS with_official_email,
             COUNT(*) FILTER (WHERE phone IS NOT NULL)::int AS with_phone,
             COUNT(*) FILTER (WHERE nirf_rank IS NOT NULL)::int AS nirf_ranked,
             ROUND(AVG(completeness_score), 1) AS average_completeness
        FROM colleges WHERE is_active
    `)) as any[];
    const [contactTotals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS contacts,
             COUNT(*) FILTER (WHERE role_category IN ('tpo','placement_head','placement_cell'))::int AS tpo_roles,
             COUNT(*) FILTER (WHERE role_category = 'principal')::int AS principals,
             COUNT(*) FILTER (WHERE role_category = 'director')::int AS directors,
             COUNT(*) FILTER (WHERE role_category = 'dean')::int AS deans,
             COUNT(*) FILTER (WHERE role_category = 'hod')::int AS hods,
             COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS emails,
             COUNT(*) FILTER (WHERE phone IS NOT NULL)::int AS phones
        FROM college_contacts
    `)) as any[];
    const byState = await sql.unsafe(`
      SELECT COALESCE(state,'unknown') AS value, COUNT(*)::int AS count FROM colleges
       WHERE is_active GROUP BY 1 ORDER BY count DESC LIMIT 40
    `);
    const byType = await sql.unsafe(`
      SELECT COALESCE(institution_type,'unknown') AS value, COUNT(*)::int AS count FROM colleges
       WHERE is_active GROUP BY 1 ORDER BY count DESC
    `);
    const byOwnership = await sql.unsafe(`
      SELECT COALESCE(ownership,'unknown') AS value, COUNT(*)::int AS count FROM colleges
       WHERE is_active GROUP BY 1 ORDER BY count DESC
    `);
    const byReadiness = await sql.unsafe(`
      SELECT outreach_readiness AS value, COUNT(*)::int AS count FROM colleges
       WHERE is_active GROUP BY 1
    `);
    const roles = await sql.unsafe(`
      SELECT role_category AS value, COUNT(*)::int AS count FROM college_contacts GROUP BY 1 ORDER BY count DESC
    `);
    return {
      measured: true,
      ...totals,
      contacts_total: contactTotals?.contacts ?? 0,
      tpo_roles: contactTotals?.tpo_roles ?? 0,
      principals: contactTotals?.principals ?? 0,
      directors: contactTotals?.directors ?? 0,
      deans: contactTotals?.deans ?? 0,
      hods: contactTotals?.hods ?? 0,
      contact_emails: contactTotals?.emails ?? 0,
      contact_phones: contactTotals?.phones ?? 0,
      by_state: byState,
      by_type: byType,
      by_ownership: byOwnership,
      by_outreach_readiness: byReadiness,
      by_role: roles,
    };
  });

  // ---------------- bulk operations ----------------
  const bulkBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

  fastify.post('/bulk-claim', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = bulkBody.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const user = req.user as { id: string; role: string };
    const result = await bulkClaim('college', bulkIds(parsed.data.ids), user);
    await logAuditEvent({
      user_id: user.id, action: 'bulk_claim_colleges', resource_type: 'college',
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
    return bulkAssign('college', bulkIds(parsed.data.ids), parsed.data.assigned_to, user);
  });

  fastify.patch('/bulk-status', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = bulkBody
      .extend({
        field: z.enum(['outreach_status', 'enrichment_status']),
        value: z.string().min(1).max(30),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
    const user = req.user as { id: string; role: string };
    return bulkStatus('college', bulkIds(parsed.data.ids), parsed.data.field, parsed.data.value, user);
  });

  fastify.get('/export', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    // Reuse the list handler's row set by calling it and serializing the data.
    const fakeReply: any = { status: () => fakeReply, send: (x: any) => x };
    const result = await list(req, fakeReply);
    const rows = (result?.data || []) as Array<Record<string, unknown>>;
    const columns = ['name', 'official_name', 'aishe_code', 'state', 'district', 'city',
      'institution_type', 'ownership', 'accreditation', 'naac_grade', 'nirf_rank',
      'website_url', 'official_email', 'phone', 'tpo_name', 'tpo_email', 'tpo_phone',
      'principal_name', 'director_name', 'dean_name', 'verification_status',
      'confidence_score', 'completeness_score', 'enrichment_status', 'outreach_readiness',
      'outreach_score', 'outreach_priority'];
    const csv = toCsv(rows, columns);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="colleges.csv"');
    return csv;
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
    const id = idParse.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    if (!(await canReadEntity(sql, 'college', id, user))) {
      return reply.status(404).send({ error: 'College not found' });
    }
    const rows = await sql.unsafe(
      `SELECT c.*, cu.email AS claimed_by_email, au.email AS assigned_to_email
         FROM colleges c
         LEFT JOIN users cu ON cu.id = c.claimed_by
         LEFT JOIN users au ON au.id = c.assigned_to
        WHERE c.id = $1`,
      [id],
    );
    if (!rows || rows.length === 0) return reply.status(404).send({ error: 'College not found' });
    const [contacts, sources, predictions, activity, notes, quality, eligibility] = await Promise.all([
      sql.unsafe(`SELECT * FROM college_contacts WHERE college_id = $1 ORDER BY priority, created_at DESC`, [id]),
      sql.unsafe(`SELECT id, source_name, source_url, extraction_method, confidence, fetched_at FROM college_sources WHERE college_id = $1 ORDER BY fetched_at DESC`, [id]),
      sql.unsafe(`SELECT * FROM college_predictions WHERE college_id = $1 ORDER BY generated_at DESC LIMIT 10`, [id]),
      sql.unsafe(`SELECT a.*, u.email AS actor_email FROM lead_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.domain = 'college' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [id]),
      sql.unsafe(`SELECT n.*, u.email AS author_email FROM lead_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.domain = 'college' AND n.entity_id = $1 ORDER BY n.created_at DESC LIMIT 100`, [id]),
      sql.unsafe(`SELECT * FROM data_quality_results WHERE domain = 'college' AND entity_id = $1`, [id]),
      sql.unsafe(`SELECT id, college_id, status, stages, attempts, contacts_found, started_at, finished_at, error
                    FROM enrichment_runs WHERE domain = 'colleges' AND entity_id = $1
                   ORDER BY started_at DESC LIMIT 20`, [id]),
    ]);
    return {
      college: rows[0],
      contacts,
      sources,
      predictions,
      activity,
      notes,
      quality: quality?.[0] || null,
      enrichment_runs: eligibility,
    };
  });

  fastify.get<{ Params: { id: string } }>('/:id/contacts', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
      return reply.status(404).send({ error: 'College not found' });
    }
    const contacts = await sql.unsafe(
      `SELECT * FROM college_contacts WHERE college_id = $1 ORDER BY priority, created_at DESC`,
      [idParse.data],
    );
    return { contacts };
  });

  fastify.get<{ Params: { id: string } }>('/:id/enrichment', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
      return reply.status(404).send({ error: 'College not found' });
    }
    const runs = await sql.unsafe(
      `SELECT * FROM enrichment_runs WHERE domain = 'colleges' AND entity_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [idParse.data],
    );
    return { runs };
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/enrich',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
        return reply.status(404).send({ error: 'College not found' });
      }
      const workersUrl = process.env.WORKERS_URL || 'http://workers:8000';
      try {
        const res = await fetch(`${workersUrl}/intelligence/colleges/${idParse.data}/enrich`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-worker-key': process.env.WORKER_API_SECRET || '',
          },
          body: JSON.stringify({ triggered_by: user.id }),
        });
        const data = await res.json();
        await logAuditEvent({
          user_id: user.id, action: 'enqueue_college_enrichment', resource_type: 'college',
          resource_id: idParse.data, details: { ok: res.ok },
        });
        await recordActivity('college', idParse.data, 'enrichment_requested', user.id, null);
        return reply.status(res.ok ? 202 : 502).send(data);
      } catch (err) {
        return reply.status(502).send({ error: 'Worker unreachable', detail: (err as Error).message });
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/claim',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
      const user = req.user as { id: string; role: string };
      const result = await claimEntity('college', idParse.data, user);
      if (result.status === 'missing') return reply.status(404).send({ error: 'College not found' });
      if (result.status === 'taken') {
        return reply.status(409).send({
          error: 'College was already claimed by another member.',
          claimed_by: (result.row as any)?.claimed_by,
          claimed_by_email: (result.row as any)?.claimed_by_email,
        });
      }
      await logAuditEvent({
        user_id: user.id, action: 'claim_college', resource_type: 'college',
        resource_id: idParse.data, details: { status: result.status },
      });
      return { college: result.row, already_owned: result.status === 'already_owned' };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/unclaim',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idParse = z.string().uuid().safeParse(req.params.id);
      if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
      const user = req.user as { id: string; role: string };
      const ok = await unclaimEntity('college', idParse.data, user);
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
      const row = await assignEntity('college', idParse.data, body.data.assigned_to ?? null, user);
      if (!row) return reply.status(400).send({ error: 'College or user not found' });
      return { college: row };
    },
  );

  fastify.get<{ Params: { id: string } }>('/:id/ownership', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
      return reply.status(404).send({ error: 'College not found' });
    }
    const rows = await sql.unsafe(
      `SELECT c.id, c.claimed_by, c.claimed_at, c.assigned_to,
              cu.email AS claimed_by_email, au.email AS assigned_to_email
         FROM colleges c
         LEFT JOIN users cu ON cu.id = c.claimed_by
         LEFT JOIN users au ON au.id = c.assigned_to
        WHERE c.id = $1`,
      [idParse.data],
    );
    return { ownership: rows[0] };
  });

  fastify.get<{ Params: { id: string } }>('/:id/activity', async (req, reply) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) return reply.status(400).send({ error: 'Invalid college id' });
    const sql = getDB();
    const user = req.user as { id: string; role: string };
    if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
      return reply.status(404).send({ error: 'College not found' });
    }
    const activity = await sql.unsafe(
      `SELECT a.*, u.email AS actor_email FROM lead_activity a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.domain = 'college' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
      [idParse.data],
    );
    return { activity };
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
      if (!(await canReadEntity(sql, 'college', idParse.data, user))) {
        return reply.status(404).send({ error: 'College not found' });
      }
      const rows = await sql.unsafe(
        `INSERT INTO lead_notes (domain, entity_id, body, author_id)
         VALUES ('college', $1, $2, $3) RETURNING *`,
        [idParse.data, body.data.body, user.id],
      );
      await recordActivity('college', idParse.data, 'note_added', user.id, null);
      return { note: rows[0] };
    },
  );
};
