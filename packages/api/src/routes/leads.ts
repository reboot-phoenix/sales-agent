import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { likeContains } from '../utils/sql';
import { getRedis } from '../utils/redis';
import { authenticate } from '../middleware/auth';
import { authorize } from '../middleware/auth';
import { recomputeLeadScore, scoreExplain, toScore10 } from '../utils/scoring';
import { logAuditEvent } from '../utils/audit';
import { publishSSE } from '../utils/sse';
import { calculateCandidateSimilarity } from '../utils/dedup';
import { LEAD_SELECT_SQL } from '../utils/leadColumns';
import { LEAD_FROM_SQL, buildLeadsWorkbook, buildLeadsCsv } from '../utils/leadWorkbook';
import { importLeadRecords, importCsvText } from '../utils/importLeads';

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(50),
  sort_by: z.enum(['lead_score', 'created_at', 'updated_at', 'company_name', 'job_title', 'source_site',
    'hr_name', 'location_type', 'salary_min', 'salary_max', 'posted_at',
    // Sorting by pipeline_stage was requested by the UI and rejected; it is a plain
    // column on leads, so there was no reason to omit it.
    'pipeline_stage', 'data_quality', 'employment_type', 'department']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  score_band: z.enum(['hot', 'warm', 'cold']).optional(),
  // Contact depth: none = no HR row at all; partial = row exists but no
  // email/mobile yet; enriched = reachable email or mobile present;
  // verified = email deliverable or WhatsApp registered.
  contact: z.enum(['none', 'partial', 'enriched', 'verified']).optional(),
  // Stored freshness label (writers set it, scheduler reclassifies).
  freshness: z.enum(['fresh', 'recent', 'older', 'unknown']).optional(),
  pipeline_stage: z
    .enum(['discovered', 'enriching', 'enriched', 'verifying', 'verified', 'drafted', 'contacted',
      'ready_for_outreach', 'message_generated', 'send_pending', 'sent', 'delivered', 'replied',
      'converted', 'bounced', 'enrichment_failed', 'verification_failed', 'contact_unavailable',
      'suppressed', 'send_failed', 'provider_error', 'retry_pending'])
    .optional(),
  source_site: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  experience: z.string().optional(),
  // Facets the scrapers now populate; without these the columns are display-only
  // and a rep cannot actually slice a queue by "remote roles paying >5L".
  location_type: z.enum(['remote', 'onsite', 'hybrid']).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  department: z.string().optional(),
  salary_min: z.coerce.number().min(0).optional(),
  // Query strings arrive as text, and Boolean("false") is true -- so z.coerce.boolean()
  // turned ?has_salary=false into true. Parse the words explicitly instead.
  has_salary: z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no'].includes(s)) return false;
      return v;
    },
    z.boolean().optional(),
  ),
  filter: z.string().optional(),
  mine: z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', '1', 'yes', 'mine'].includes(s)) return true;
      if (['false', '0', 'no'].includes(s)) return false;
      return v;
    },
    z.boolean().optional(),
  ),
  ownership: z.enum(['unclaimed', 'claimed', 'assigned', 'mine']).optional(),
});

const leadIdSchema = z.object({
  id: z.string().uuid(),
});

const enrichSchema = z.object({
  provider: z.enum(['auto', 'contactout', 'snovio', 'osint', 'hunter', 'apollo', 'apollo_io', 'lusha', 'rocketreach', 'prospeo', 'findymail']).optional(),
});

const draftSchema = z.object({
  channel: z.enum(['email', 'whatsapp', 'both']).default('both'),
});

const sendSchema = z.object({
  channel: z.enum(['email', 'whatsapp', 'both']).default('both'),
  draft_id: z.string().uuid().optional(),
});

const verifyAndSendSchema = z.object({
  channel: z.enum(['email', 'whatsapp', 'both']).default('both'),
  draft_id: z.string().uuid().optional(),
});


/**
 * Shared WHERE builder for GET /leads and GET /leads/export. Both must apply the
 * identical RBAC scope and filters, or an export silently contains rows the user
 * cannot see (or omits ones they filtered for).
 */
function buildLeadFilters(q: any, user: { id: string; role: string }) {
   const conditions: string[] = [];
   const values: unknown[] = [];
   let paramIdx = 1;

    // RBAC: sales_rep sees only owned leads (claimed OR assigned), admin sees all.
    // Ownership is the source of truth; claimed_by added alongside assigned_to.
    // Exception: the `unclaimed` filter is the claim pool — every member must see
    // it, or Claim is unreachable. Unclaimed rows have no owner to leak.
    if (user.role === 'sales_rep' && q.ownership !== 'unclaimed') {
      conditions.push(`(l.assigned_to = $${paramIdx} OR l.claimed_by = $${paramIdx})`);
      values.push(user.id);
      paramIdx++;
    }
    // ?mine=true scopes to current user regardless of role (My Leads page).
    if (q.mine === true) {
      conditions.push(`(l.assigned_to = $${paramIdx} OR l.claimed_by = $${paramIdx})`);
      values.push(user.id);
      paramIdx++;
    }
    if (q.ownership === 'mine') {
      conditions.push(`(l.assigned_to = $${paramIdx} OR l.claimed_by = $${paramIdx})`);
      values.push(user.id);
      paramIdx++;
    } else if (q.ownership === 'unclaimed') {
      conditions.push(`(l.claimed_by IS NULL AND l.assigned_to IS NULL)`);
    } else if (q.ownership === 'claimed') {
      conditions.push(`(l.claimed_by IS NOT NULL)`);
    } else if (q.ownership === 'assigned') {
      conditions.push(`(l.assigned_to IS NOT NULL)`);
    }

   if (q.score_band) {
     conditions.push(`l.score_band = $${paramIdx}`);
     values.push(q.score_band);
     paramIdx++;
   }
   if (q.contact === 'none') {
     conditions.push(`l.hr_contact_id IS NULL`);
   } else if (q.contact === 'partial') {
     conditions.push(`(l.hr_contact_id IS NOT NULL AND COALESCE(hc.personal_email, '') = '' AND COALESCE(hc.personal_mobile, '') = '')`);
   } else if (q.contact === 'enriched') {
     conditions.push(`(COALESCE(hc.personal_email, '') <> '' OR COALESCE(hc.personal_mobile, '') <> '')`);
   } else if (q.contact === 'verified') {
     conditions.push(`(l.email_status = 'valid' OR l.whatsapp_status = 'registered')`);
   }
   if (q.freshness) {
     conditions.push(`jp.freshness_category = $${paramIdx}`);
     values.push(q.freshness);
     paramIdx++;
   }
   if (q.pipeline_stage) {
     conditions.push(`l.pipeline_stage = $${paramIdx}`);
     values.push(q.pipeline_stage);
     paramIdx++;
   }
   if (q.source_site) {
     conditions.push(`jp.source_site = $${paramIdx}`);
     values.push(q.source_site);
     paramIdx++;
   }
   if (q.date_from) {
     conditions.push(`l.created_at >= $${paramIdx}::timestamptz`);
     values.push(q.date_from);
     paramIdx++;
   }
   if (q.date_to) {
     conditions.push(`l.created_at <= $${paramIdx}::timestamptz`);
     values.push(q.date_to);
     paramIdx++;
   }
     if (q.experience) {
       // Exact equality made the UI's "Fresher" option return nothing: stored values
       // are free text from 48 boards ("0-1 years", "0 to 2 Years", "Experienced,
       // Fresher"), so 194 rows mentioning fresher matched zero. Map the coarse UI
       // buckets onto that text; anything unrecognised still falls back to a match.
       const EXPERIENCE_MATCH: Record<string, string> = {
         fresher: `(lower(coalesce(jp.experience_level, '')) like '%fresher%'
                    or lower(coalesce(jp.experience_level, '')) like '%entry level%'
                    or lower(coalesce(jp.experience_level, '')) like '%entry-level%'
                    or coalesce(jp.experience_level, '') ~ '^\\s*0(\\s*-|\\s*to)')`,
         'no-experience': `(lower(coalesce(jp.experience_level, '')) like '%no experience%'
                           or lower(coalesce(jp.experience_level, '')) like '%fresher%')`,
         '0-1yr': `coalesce(jp.experience_level, '') ~ '^\\s*0\\s*-\\s*1'`,
         '0-2yr': `coalesce(jp.experience_level, '') ~ '^\\s*0\\s*(-|\\s*to)\\s*2'`,
       };
       const expr = EXPERIENCE_MATCH[q.experience];
       if (expr) {
         conditions.push(expr);
       } else {
         conditions.push(`lower(coalesce(jp.experience_level, '')) = lower($${paramIdx})`);
         values.push(q.experience);
         paramIdx++;
       }
     }
   if (q.location_type) {
     conditions.push(`jp.location_type = $${paramIdx}`);
     values.push(q.location_type);
     paramIdx++;
   }
   if (q.city) {
     conditions.push(`jp.city ILIKE $${paramIdx} ESCAPE '\\'`);
     values.push(likeContains(q.city));
     paramIdx++;
   }
   if (q.state) {
     conditions.push(`jp.state ILIKE $${paramIdx} ESCAPE '\\'`);
     values.push(likeContains(q.state));
     paramIdx++;
   }
   if (q.department) {
     conditions.push(`jp.department ILIKE $${paramIdx} ESCAPE '\\'`);
     values.push(likeContains(q.department));
     paramIdx++;
   }
   if (q.salary_min != null) {
     // COALESCE lets a source that only gives text still match on its numeric
     // floor when one exists, and excludes rows with no pay data at all.
     conditions.push(`COALESCE(jp.salary_min, NULL) >= $${paramIdx}`);
     values.push(q.salary_min);
     paramIdx++;
   }
   if (q.has_salary === true) {
     conditions.push(`(jp.salary_min IS NOT NULL OR COALESCE(jp.salary_range, '') <> '')`);
   } else if (q.has_salary === false) {
     conditions.push(`(jp.salary_min IS NULL AND COALESCE(jp.salary_range, '') = '')`);
   }
   if (q.filter) {
     conditions.push(`(c.name ILIKE $${paramIdx} ESCAPE '\\' OR c.domain ILIKE $${paramIdx} ESCAPE '\\' OR jp.title ILIKE $${paramIdx} ESCAPE '\\' OR jp.source_site ILIKE $${paramIdx} ESCAPE '\\' OR jp.city ILIKE $${paramIdx} ESCAPE '\\' OR jp.state ILIKE $${paramIdx} ESCAPE '\\' OR hc.full_name ILIKE $${paramIdx} ESCAPE '\\' OR hc.personal_email ILIKE $${paramIdx} ESCAPE '\\' OR hc.personal_mobile ILIKE $${paramIdx} ESCAPE '\\')`);
     values.push(likeContains(q.filter));
     paramIdx++;
   }
   return { conditions, values, paramIdx };
}

/**
 * Per-lead ownership: admin sees all; sales_rep only leads they own
 * (assigned_to OR claimed_by). Every mutating/reading single-lead route must
 * consult this server-side — frontend hiding is not authorization.
 */
async function ownsLead(
  sql: { unsafe: (q: string, p?: unknown) => Promise<unknown> },
  leadId: string,
  user: { id: string; role: string },
): Promise<boolean> {
  if (user.role === 'admin') {
    const rows = (await sql.unsafe(`SELECT 1 FROM leads WHERE id = $1`, [leadId])) as unknown[];
    return rows.length > 0;
  }
  const rows = (await sql.unsafe(
    `SELECT 1 FROM leads WHERE id = $1 AND (assigned_to = $2 OR claimed_by = $2)`,
    [leadId, user.id],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * Read access: owned leads plus the unclaimed pool (so members can inspect
 * a lead before claiming it). Mutations stay owner-only via ownsLead.
 */
async function canReadLead(
  sql: { unsafe: (q: string, p?: unknown) => Promise<unknown> },
  leadId: string,
  user: { id: string; role: string },
): Promise<boolean> {
  if (user.role === 'admin') {
    const rows = (await sql.unsafe(`SELECT 1 FROM leads WHERE id = $1`, [leadId])) as unknown[];
    return rows.length > 0;
  }
  const rows = (await sql.unsafe(
    `SELECT 1 FROM leads WHERE id = $1 AND (assigned_to = $2 OR claimed_by = $2
       OR (claimed_by IS NULL AND assigned_to IS NULL))`,
    [leadId, user.id],
  )) as unknown[];
  return rows.length > 0;
}

export const leadsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  async function handleListLeads(req: FastifyRequest, reply: any, forceMine = false) {
    const rawQuery = { ...((req.query as Record<string, unknown>) || {}) };
    if (forceMine) rawQuery.mine = 'true';
    const parseResult = paginationSchema.safeParse(rawQuery);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parseResult.error.issues });
    }
    const q = parseResult.data;
    const user = req.user as { id: string; role: string };

    const offset = (q.page - 1) * q.limit;
    const sql = getDB();

    const { conditions, values } = buildLeadFilters(q, user);
    // Each pushed value consumed exactly one placeholder, so the next free $n
    // is one past the number bound so far.
    let paramIdx = values.length + 1;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDir = q.sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    // Whitelisted output aliases/columns; anything else falls back to created_at
    const sortColumns: Record<string, string> = {
      lead_score: 'l.lead_score',
      created_at: 'l.created_at',
      updated_at: 'l.updated_at',
      company_name: 'company_name',
      job_title: 'job_title',
      source_site: 'source_site',
      // Whitelisted mapping only -- q.sort_by is validated by zod above and never
      // interpolated directly, so ORDER BY cannot be injected. NULLS placement is
      // appended after the direction (see nullsTail), not here.
      location_type: 'jp.location_type',
      pipeline_stage: 'l.pipeline_stage',
      data_quality: 'l.data_quality',
      employment_type: 'jp.employment_type',
      department: 'jp.department',
      salary_min: 'jp.salary_min',
      salary_max: 'jp.salary_max',
      posted_at: 'jp.posted_at',
      hr_name: 'hr_name',
    };
    const sortColumn = sortColumns[q.sort_by] || 'l.created_at';
    // Nullable facets must push NULLs last in DESC (and first in ASC) or the
    // default Postgres ordering makes "highest salary" return rows with no pay.
    // Sparse facets always sort NULLs last, in BOTH directions. The previous
    // direction-dependent rule meant clicking Salary to get "cheapest first" opened
    // with 25 rows that have no salary at all -- the column looked empty and broken.
    // A user sorting by a facet wants populated values first either way.
    const SPARSE_SORT_COLUMNS = ['salary_min', 'salary_max', 'posted_at', 'employment_type', 'department'];
    const nullsTail = SPARSE_SORT_COLUMNS.includes(q.sort_by) ? ' NULLS LAST' : '';

    const countQuery = `
      SELECT COUNT(*) as total
      FROM leads l
      JOIN companies c ON l.company_id = c.id
      JOIN job_postings jp ON l.job_posting_id = jp.id
      LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
      ${whereClause}
    `;
    const countResult = await sql.unsafe(countQuery, values as any);
    const countRow = countResult[0] as unknown as { total: number } | undefined;
    const total = Number(countRow?.total ?? 0);

    const rows = await sql.unsafe(`
      SELECT ${LEAD_SELECT_SQL}
      ${LEAD_FROM_SQL}
      ${whereClause}
      ORDER BY ${sortColumn} ${orderDir}${nullsTail}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, [...values, q.limit, offset] as any);

    const pages = Math.ceil(total / q.limit);

    return {
      data: rows,
      pagination: {
        page: q.page,
        limit: q.limit,
        total,
        pages,
      },
    };
  }

  // My Leads: server-side ownership filter (claimed OR assigned). Registered
  // before /:id so "my" is never parsed as a UUID.
  fastify.get('/my', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    return handleListLeads(req, reply, true);
  });

  fastify.get('/', async (req, reply) => {
    return handleListLeads(req, reply, false);
  });

  fastify.get<{ Params: { id: string } }>(
    '/:id',
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const sql = getDB();

      const user = req.user as { id: string; role: string };

      let query = `
        SELECT
          l.*,
          c.name as company_name, c.domain, c.about as about_company,
          c.industry, c.size_estimate, c.default_email, c.default_phone, c.website_url,
          hc.full_name as hr_name,
          hc.linkedin_url as hr_linkedin_url, hc.personal_email as hr_email,
          hc.personal_mobile as hr_mobile, hc.confidence_score as hr_confidence,
          jp.title as job_title, jp.description as job_description,
          jp.experience_level, jp.salary_range, jp.job_url, jp.source_site,
          jp.location, jp.city, jp.state, jp.country, jp.location_type,
          jp.employment_type, jp.is_work_from_home, jp.apply_url, jp.posted_at,
          jp.about_job, jp.department, jp.openings_count,
          jp.salary_min, jp.salary_max, jp.salary_currency, jp.salary_period,
          cu.email AS claimed_by_email, au.email AS assigned_to_email
        FROM leads l
        JOIN companies c ON l.company_id = c.id
        LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
        JOIN job_postings jp ON l.job_posting_id = jp.id
        LEFT JOIN users cu ON cu.id = l.claimed_by
        LEFT JOIN users au ON au.id = l.assigned_to
        WHERE l.id = $1`;
      
      const values: (string | number)[] = [id];
      
      if (user.role === 'sales_rep') {
        query += ' AND (l.assigned_to = $2 OR l.claimed_by = $2 OR (l.claimed_by IS NULL AND l.assigned_to IS NULL))';
        values.push(user.id);
      }

      const lead = await sql.unsafe(query, values);

      if (!lead || lead.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const enrichmentLogs = await sql.unsafe(
        `SELECT * FROM enrichment_log WHERE lead_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      const verificationLogs = await sql.unsafe(
        `SELECT * FROM verification_log WHERE lead_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      const drafts = await sql.unsafe(
        `SELECT * FROM outreach_drafts WHERE lead_id = $1 ORDER BY version`,
        [id],
      );

      const outreachLogs = await sql.unsafe(
        `SELECT * FROM outreach_log WHERE lead_id = $1 ORDER BY sent_at DESC`,
        [id],
      );

      return {
        lead: {
          ...lead[0],
          enrichment_log: enrichmentLogs,
          verification_log: verificationLogs,
          drafts,
          outreach_log: outreachLogs,
        },
      };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id/score',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) return reply.status(400).send({ error: 'Invalid lead ID' });
      const { id } = idResult.data;
      const sql = getDB();
      const user = req.user as { id: string; role: string };

      if (!(await canReadLead(sql, id, user))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const explained = await scoreExplain(sql, id);
      if (!explained) return reply.status(404).send({ error: 'Lead not found' });
      return { ...explained, score_10: toScore10(explained.score) };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/enrich',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const parseResult = enrichSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { provider } = parseResult.data;
      const prov = provider || 'auto';
      const me = req.user as { id: string; role: string };
      const sql = getDB();

      // Ownership guard: reps may only enrich leads they own.
      if (me.role !== 'admin') {
        const owned = await sql.unsafe(
          `SELECT 1 FROM leads WHERE id = $1 AND (assigned_to = $2 OR claimed_by = $2)`,
          [id, me.id],
        );
        if (!owned || owned.length === 0) {
          return reply.status(404).send({ error: 'Lead not found' });
        }
      } else {
        const exists = await sql.unsafe(`SELECT 1 FROM leads WHERE id = $1`, [id]);
        if (!exists || exists.length === 0) {
          return reply.status(404).send({ error: 'Lead not found' });
        }
      }

      // Idempotency: a live job for the same lead+provider is reused, never duplicated.
      // Keyed per lead+provider+day so a double-click returns the same job.
      const day = new Date().toISOString().slice(0, 10);
      const idemKey = `${id}:${prov}:${day}`;
      const live = await sql.unsafe(
        `SELECT id, status, updated_at FROM enrichment_jobs
          WHERE idempotency_key = $1 AND status IN ('queued','running') LIMIT 1`,
        [idemKey],
      );
      if (live && live.length > 0) {
        const row = live[0] as unknown as { id: string; status: string; updated_at: string };
        const staleMs = Date.now() - new Date(row.updated_at).getTime();
        // Crash recovery: a worker that died mid-job leaves `running` forever
        // and idempotency would then block the lead all day. Reclaim stale runs.
        if (row.status === 'running' && staleMs > 15 * 60 * 1000) {
          await sql.unsafe(
            `UPDATE enrichment_jobs SET status = 'queued', current_stage = 'reclaimed',
               attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
            [row.id],
          );
          await getRedis().lpush(
            'enrichment_queue:requests',
            JSON.stringify({
              lead_id: id, provider: prov, job_id: row.id,
              requested_by: me.id, requested_at: new Date().toISOString(),
            }),
          );
          await logAuditEvent({
            user_id: me.id, action: 'enqueue_enrichment', resource_type: 'lead',
            resource_id: id, details: { provider: prov, job_id: row.id, reclaimed: true },
          });
          return reply.status(202).send({
            message: 'Stale enrichment job reclaimed and requeued',
            job_id: row.id, lead_id: id, provider: prov, reclaimed: true,
          });
        }
        return reply.status(202).send({
          message: 'Enrichment already queued',
          job_id: row.id,
          lead_id: id,
          provider: prov,
          deduped: true,
        });
      }

      const jobRows = await sql.unsafe(
        `INSERT INTO enrichment_jobs (lead_id, provider, status, current_stage, idempotency_key, requested_by)
         VALUES ($1, $2, 'queued', 'queued', $3, $4)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
         RETURNING id, status`,
        [id, prov, idemKey, me.id],
      );
      const jobUuid = (jobRows[0] as unknown as { id: string }).id;

      const redis = getRedis();
      await redis.lpush(
        'enrichment_queue:requests',
        JSON.stringify({
          lead_id: id,
          provider: prov,
          job_id: jobUuid,
          requested_by: me.id,
          requested_at: new Date().toISOString(),
        }),
      );

      await logAuditEvent({
        user_id: me.id,
        action: 'enqueue_enrichment',
        resource_type: 'lead',
        resource_id: id,
        details: { provider: prov, job_id: jobUuid },
      });

      await publishSSE(me.id, {
        type: 'enrichment_queued',
        lead_id: id,
        job_id: jobUuid,
        provider: prov,
      });

      await recomputeLeadScore(getDB(), id);

      return reply.status(202).send({
        message: 'Enrichment job queued',
        job_id: jobUuid,
        lead_id: id,
        provider: prov,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/verify',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const verifier = req.user as { id: string; role: string };
      if (!(await ownsLead(getDB(), id, verifier))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const redis = getRedis();
      const jobId = await redis.lpush(
        'verification_queue:requests',
        JSON.stringify({
          lead_id: id,
          requested_by: (req.user as { id: string }).id,
          requested_at: new Date().toISOString(),
        }),
      );

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'enqueue_verification',
        resource_type: 'lead',
        resource_id: id,
        details: { job_id: String(jobId) },
      });

      await publishSSE((req.user as { id: string }).id, {
        type: 'verification_queued',
        lead_id: id,
        job_id: String(jobId),
      });

      await recomputeLeadScore(getDB(), id);

      return reply.status(202).send({
        message: 'Verification job queued',
        job_id: String(jobId),
        lead_id: id,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/draft',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const parseResult = draftSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { channel } = parseResult.data;
      const drafter = req.user as { id: string; role: string };
      if (!(await ownsLead(getDB(), id, drafter))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const redis = getRedis();
      const jobId = await redis.lpush(
        'draft_queue:requests',
        JSON.stringify({
          lead_id: id,
          channel,
          requested_by: (req.user as { id: string }).id,
          requested_at: new Date().toISOString(),
        }),
      );

       await logAuditEvent({
         user_id: (req.user as { id: string }).id,
         action: 'enqueue_draft',
         resource_type: 'lead',
         resource_id: id,
         details: { channel, job_id: String(jobId) },
       });

       await publishSSE((req.user as { id: string }).id, {
         type: 'draft_queued',
         lead_id: id,
         job_id: String(jobId),
         channel,
       });

       await recomputeLeadScore(getDB(), id);

       return reply.status(202).send({
         message: 'Draft generation job queued',
        job_id: String(jobId),
        lead_id: id,
        channel,
      });
    },
  );

  fastify.patch<{ Params: { id: string; draftId: string } }>(
    '/:id/draft/:draftId',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
        draftId: z.string().uuid(),
      });
      const parseResult = paramsSchema.safeParse(req.params);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid parameters' });
      }
      const { id, draftId } = parseResult.data;

      const bodySchema = z.object({
        subject: z.string().optional(),
        body: z.string().optional(),
      });
      const bodyResult = bodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { subject, body } = bodyResult.data;

      const sql = getDB();
      const me = req.user as { id: string; role: string };
      if (!(await ownsLead(sql, id, me))) {
        return reply.status(404).send({ error: 'Draft not found' });
      }
      const updateFields: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (subject !== undefined) {
        updateFields.push(`subject = $${idx}`);
        values.push(subject);
        idx++;
      }
      if (body !== undefined) {
        updateFields.push(`body = $${idx}`);
        values.push(body);
        idx++;
      }
      if (updateFields.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }

      updateFields.push(`is_edited = true`);
      updateFields.push(`updated_at = now()`);
      values.push(draftId, id);

      const result = await sql.unsafe(
        `UPDATE outreach_drafts
         SET ${updateFields.join(', ')}
         WHERE id = $${values.length - 1} AND lead_id = $${values.length}
         RETURNING id, lead_id, channel, version, subject, body, is_edited, created_at`,
        values as any,
      );

      if (!result || result.length === 0) {
        return reply.status(404).send({ error: 'Draft not found' });
      }

      return { draft: result[0] };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/send',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const parseResult = sendSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { channel, draft_id } = parseResult.data;
      const sender = req.user as { id: string; role: string };
      if (!(await ownsLead(getDB(), id, sender))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const sql = getDB();
      const lead = await sql.unsafe(
        `SELECT l.email_status, l.whatsapp_status, l.do_not_contact,
                hc.personal_email AS hr_email, hc.personal_mobile AS hr_mobile
         FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
         WHERE l.id = $1`,
        [id],
      );

      if (!lead || lead.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const leadRow = lead[0] as unknown as { email_status: string | null; whatsapp_status: string | null; do_not_contact: boolean; hr_email: string | null; hr_mobile: string | null } | null;
      if (!leadRow) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      if (leadRow.do_not_contact) {
        await logAuditEvent({
          user_id: (req.user as { id: string }).id,
          action: 'send_blocked_do_not_contact',
          resource_type: 'lead',
          resource_id: id,
          details: { reason: 'Lead is flagged do_not_contact' },
        });
        return reply.status(403).send({
          error: 'Cannot send to do-not-contact lead',
          detail: 'This lead is flagged do_not_contact (bounced or opted out).',
        });
      }

      // Server-side suppression check (never rely on frontend or flag sync alone).
      const contactsToCheck = [leadRow.hr_email?.toLowerCase().trim(), leadRow.hr_mobile?.toLowerCase().trim()].filter(Boolean) as string[];
      if (contactsToCheck.length > 0) {
        const suppressed = await sql.unsafe(
          `SELECT 1 FROM suppressions WHERE normalized_contact = ANY($1::text[])
             OR (channel = 'any' AND normalized_contact = ANY($1::text[])) LIMIT 1`,
          [contactsToCheck],
        );
        if (suppressed && suppressed.length > 0) {
          await logAuditEvent({
            user_id: (req.user as { id: string }).id,
            action: 'send_blocked_suppressed',
            resource_type: 'lead',
            resource_id: id,
            details: { reason: 'Contact found in suppressions blocklist' },
          });
          return reply.status(403).send({
            error: 'Cannot send to suppressed contact',
            detail: 'This contact is on the do-not-contact / suppression list.',
          });
        }
      }

      if (channel === 'email' || channel === 'both') {
        if (leadRow.email_status !== 'valid') {
          return reply.status(400).send({
            error: 'Email not verified',
            detail: 'Email status is ' + (leadRow.email_status || 'unknown') + '. Verify before sending.',
          });
        }
      }
      if (channel === 'whatsapp' || channel === 'both') {
        if (leadRow.whatsapp_status !== 'registered') {
          return reply.status(400).send({
            error: 'WhatsApp not verified',
            detail: 'WhatsApp status is ' + (leadRow.whatsapp_status || 'unknown') + '. Verify before sending.',
          });
        }
      }

      const redis = getRedis();
      const jobId = await redis.lpush(
        'send_queue:requests',
        JSON.stringify({
          lead_id: id,
          channel,
          draft_id: draft_id || null,
          requested_by: (req.user as { id: string }).id,
          requested_at: new Date().toISOString(),
        }),
      );

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'enqueue_send',
        resource_type: 'lead',
        resource_id: id,
        details: { channel, draft_id: draft_id || null, job_id: String(jobId) },
      });

      await publishSSE((req.user as { id: string }).id, {
        type: 'send_queued',
        lead_id: id,
        job_id: String(jobId),
        channel,
      });

      // NOTE: do NOT optimistically set pipeline_stage='contacted' here. The
      // worker sets it ONLY after the provider reports a real send. Marking it
      // on enqueue would be a fake-success state (button clicked ≠ message sent).
      return reply.status(202).send({
        message: 'Send job queued',
        job_id: String(jobId),
        lead_id: id,
        channel,
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/verify-and-send',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
    },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const parseResult = verifyAndSendSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { channel, draft_id } = parseResult.data;

      // Fail fast on suppressed/unverified leads instead of queueing work that
      // the worker would only reject later. Worker re-checks server-side too.
      const vsender = req.user as { id: string; role: string };
      if (!(await ownsLead(getDB(), id, vsender))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const sql = getDB();
      const preLead = await sql.unsafe(
        `SELECT l.email_status, l.whatsapp_status, l.do_not_contact,
                hc.personal_email AS hr_email, hc.personal_mobile AS hr_mobile
         FROM leads l LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
         WHERE l.id = $1`,
        [id],
      );
      const pre = preLead?.[0] as unknown as { email_status: string | null; whatsapp_status: string | null; do_not_contact: boolean; hr_email: string | null; hr_mobile: string | null } | undefined;
      if (!pre) return reply.status(404).send({ error: 'Lead not found' });
      if (pre.do_not_contact) {
        await logAuditEvent({ user_id: (req.user as { id: string }).id, action: 'send_blocked_do_not_contact', resource_type: 'lead', resource_id: id, details: { flow: 'verify-and-send' } });
        return reply.status(403).send({ error: 'Cannot send to do-not-contact lead' });
      }
      const preContacts = [pre.hr_email?.toLowerCase().trim(), pre.hr_mobile?.toLowerCase().trim()].filter(Boolean) as string[];
      if (preContacts.length > 0) {
        const hit = await sql.unsafe(`SELECT 1 FROM suppressions WHERE normalized_contact = ANY($1::text[]) LIMIT 1`, [preContacts]);
        if (hit && hit.length > 0) {
          await logAuditEvent({ user_id: (req.user as { id: string }).id, action: 'send_blocked_suppressed', resource_type: 'lead', resource_id: id, details: { flow: 'verify-and-send' } });
          return reply.status(403).send({ error: 'Cannot send to suppressed contact' });
        }
      }

      const redis = getRedis();
      const jobId = await redis.lpush(
        'verify_send_queue:requests',
        JSON.stringify({
          lead_id: id,
          channel,
          draft_id: draft_id || null,
          requested_by: (req.user as { id: string }).id,
          requested_at: new Date().toISOString(),
        }),
      );

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'enqueue_verify_and_send',
        resource_type: 'lead',
        resource_id: id,
        details: { channel, draft_id: draft_id || null, job_id: String(jobId) },
      });

      await publishSSE((req.user as { id: string }).id, {
        type: 'verify_and_send_queued',
        lead_id: id,
        job_id: String(jobId),
        channel,
      });

      // No premature 'contacted': the verify-send worker sets it only on a real
      // provider success (and blocks on do-not-contact / failed verification).
      return reply.status(202).send({
        message: 'Verify & Send job queued',
        job_id: String(jobId),
        lead_id: id,
        channel,
      });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id/timeline',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const sql = getDB();

      // The timeline exposes enrichment providers, verification results, draft bodies and
      // delivery status. GET /:id scopes that to the assigned rep; this route did not, so
      // any rep could enumerate UUIDs and read another rep's outreach history.
      const viewer = req.user as { id: string; role: string };
      if (!(await canReadLead(sql, id, viewer))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      const enrichment = await sql.unsafe(
        `SELECT id, provider, status, credits_used, created_at FROM enrichment_log WHERE lead_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      const verification = await sql.unsafe(
        `SELECT id, channel, result, created_at FROM verification_log WHERE lead_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      const drafts = await sql.unsafe(
        `SELECT id, channel, version, generated_by, is_edited, created_at FROM outreach_drafts WHERE lead_id = $1 ORDER BY version`,
        [id],
      );

      const outreach = await sql.unsafe(
        `SELECT id, channel, provider_message_id, delivery_status, sent_at FROM outreach_log WHERE lead_id = $1 ORDER BY sent_at DESC`,
        [id],
      );

      const audits = await sql.unsafe(
        `SELECT a.action, a.details, a.created_at, u.email AS actor_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.resource_type = 'lead' AND a.resource_id = $1
            AND a.action IN ('claim_lead','assign_lead','enqueue_enrichment','merge_duplicate','set_do_not_contact','clear_do_not_contact')
          ORDER BY a.created_at DESC LIMIT 50`,
        [id],
      );

      const timeline: Array<Record<string, unknown>> = [];

      for (const a of audits) {
        timeline.push({
          type: a.action === 'claim_lead' ? 'claimed' : a.action === 'assign_lead' ? 'assigned' : 'activity',
          action: a.action,
          details: a.details,
          actor: a.actor_email,
          timestamp: a.created_at,
        });
      }

      for (const e of enrichment) {
        timeline.push({
          type: 'enrichment',
          provider: e.provider,
          status: e.status,
          credits_used: e.credits_used,
          timestamp: e.created_at,
        });
      }
      for (const v of verification) {
        timeline.push({
          type: 'verification',
          channel: v.channel,
          result: v.result,
          timestamp: v.created_at,
        });
      }
      for (const d of drafts) {
        timeline.push({
          type: 'draft_created',
          channel: d.channel,
          version: d.version,
          generated_by: d.generated_by,
          is_edited: d.is_edited,
          timestamp: d.created_at,
        });
      }
      for (const o of outreach) {
        timeline.push({
          type: 'outreach',
          channel: o.channel,
          delivery_status: o.delivery_status,
          timestamp: o.sent_at,
        });
      }

      timeline.sort((a, b) => {
        const ta = new Date(a.timestamp as string).getTime();
        const tb = new Date(b.timestamp as string).getTime();
        return tb - ta;
      });

      return { timeline };
    },
  );

  fastify.post(
    '/bulk-draft',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const bodySchema = z.object({
        lead_ids: z.array(z.string().uuid()).min(1).max(50),
        channel: z.enum(['email', 'whatsapp', 'both']).default('both'),
      });
      const parseResult = bodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { lead_ids, channel } = parseResult.data;

      // Drafting is a write against someone's pipeline. Passing arbitrary UUIDs used to
      // queue work on leads the caller cannot see or edit; filter to the ones they own.
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      const permitted = await sql.unsafe(
        `SELECT id FROM leads WHERE id = ANY($1::uuid[]) AND ($2::text = 'admin' OR assigned_to = $3::uuid OR claimed_by = $3::uuid)`,
        [lead_ids, user.role, user.id],
      );
      const allowed = new Set((permitted as unknown as Array<{ id: string }>).map((r) => r.id));
      const rejected = lead_ids.filter((id) => !allowed.has(id));
      if (allowed.size === 0) {
        return reply.status(403).send({ error: 'None of these leads are yours to draft' });
      }

      const redis = getRedis();
      const jobId = await redis.lpush(
        'bulk_draft_queue:requests',
        JSON.stringify({
          lead_ids: [...allowed],
          channel,
          requested_by: user.id,
          requested_at: new Date().toISOString(),
        }),
      );

      return reply.status(202).send({
        message: 'Bulk draft job queued',
        job_id: String(jobId),
        lead_ids: [...allowed],
        rejected_lead_ids: rejected,
        channel,
      });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/do-not-contact',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;

      const bodySchema = z.object({
        do_not_contact: z.boolean(),
      });
      const parseResult = bodySchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { do_not_contact } = parseResult.data;

      const sql = getDB();
      const dncUser = req.user as { id: string; role: string };
      if (!(await ownsLead(sql, id, dncUser))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const result = await sql.unsafe(
        `UPDATE leads SET do_not_contact = $1, updated_at = NOW() WHERE id = $2 RETURNING id, do_not_contact`,
        [do_not_contact, id],
      );

      if (!result || result.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: do_not_contact ? 'set_do_not_contact' : 'clear_do_not_contact',
        resource_type: 'lead',
        resource_id: id,
        details: { do_not_contact },
      });

      return { lead: result[0] };
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/assign',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;

      const bodySchema = z.object({
        assigned_to: z.string().uuid().nullable().optional(),
      });
      const parseResult = bodySchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { assigned_to } = parseResult.data;

      const sql = getDB();

      if (assigned_to) {
        const user = await sql.unsafe(`SELECT id FROM users WHERE id = $1`, [assigned_to]);
        if (!user || user.length === 0) {
          return reply.status(400).send({ error: 'Assigned user not found' });
        }
      }

      const result = await sql.unsafe(
        `UPDATE leads SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING id, assigned_to`,
        [assigned_to as any, id],
      );

      if (!result || result.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'assign_lead',
        resource_type: 'lead',
        resource_id: id,
        details: { assigned_to: assigned_to || null },
      });

      await publishSSE((req.user as { id: string }).id, {
        type: 'lead_assigned',
        lead_id: id,
        assigned_to: assigned_to || null,
      });

      return { lead: result[0] };
    },
  );

  // Atomic claim: only one claimant can win. The UPDATE is the lock — the
  // WHERE clause fails for every loser, so concurrent clicks cannot double-own.
  fastify.post<{ Params: { id: string } }>(
    '/:id/claim',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const me = req.user as { id: string; role: string };
      const sql = getDB();

      const result = await sql.unsafe(
        `UPDATE leads SET claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND claimed_by IS NULL
          RETURNING id, claimed_by, claimed_at, assigned_to`,
        [me.id, id],
      );

      if (result && result.length > 0) {
        await logAuditEvent({
          user_id: me.id,
          action: 'claim_lead',
          resource_type: 'lead',
          resource_id: id,
          details: { claimed_by: me.id },
        });
        await publishSSE(me.id, { type: 'lead_claimed', lead_id: id, claimed_by: me.id });
        return { lead: result[0] };
      }

      // Lost the race (or lead missing): distinguish so the UI can say why.
      const existing = await sql.unsafe(
        `SELECT l.claimed_by, u.email AS claimed_by_email FROM leads l
          LEFT JOIN users u ON u.id = l.claimed_by WHERE l.id = $1`,
        [id],
      );
      if (!existing || existing.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const row = existing[0] as unknown as { claimed_by: string | null; claimed_by_email: string | null };
      if (row.claimed_by === me.id) {
        return { lead: row, already_owned: true };
      }
      return reply.status(409).send({
        error: 'Lead was already claimed by another member.',
        claimed_by: row.claimed_by,
        claimed_by_email: row.claimed_by_email,
      });
    },
  );

  // Ownership snapshot for badges: never ambiguous, always server-side.
  fastify.get<{ Params: { id: string } }>(
    '/:id/ownership',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const sql = getDB();
      const ownerViewer = req.user as { id: string; role: string };
      if (!(await canReadLead(sql, id, ownerViewer))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const rows = await sql.unsafe(
        `SELECT l.id, l.claimed_by, l.claimed_at, l.assigned_to,
                cu.email AS claimed_by_email, au.email AS assigned_to_email
           FROM leads l
           LEFT JOIN users cu ON cu.id = l.claimed_by
           LEFT JOIN users au ON au.id = l.assigned_to
          WHERE l.id = $1`,
        [id],
      );
      if (!rows || rows.length === 0) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      return { ownership: rows[0] };
    },
  );

  // Latest enrichment job for a lead (poll target for Queued→Running→Completed).
  fastify.get<{ Params: { id: string } }>(
    '/:id/enrichment',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;
      const sql = getDB();
      const enrViewer = req.user as { id: string; role: string };
      if (!(await canReadLead(sql, id, enrViewer))) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      const jobs = await sql.unsafe(
        `SELECT * FROM enrichment_jobs WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [id],
      );
      const logs = await sql.unsafe(
        `SELECT id, provider, status, credits_used, created_at FROM enrichment_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      );
      return { jobs, log: logs };
    },
  );

  // Single enrichment job by id (survives refresh; DB is source of truth).
  fastify.get(
    '/enrichment/jobs/:jobId',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const schema = z.object({ jobId: z.string().uuid() });
      const parsed = schema.safeParse(req.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid job ID' });
      }
      const sql = getDB();
      const jobViewer = req.user as { id: string; role: string };
      const rows = await sql.unsafe(
        `SELECT j.* FROM enrichment_jobs j JOIN leads l ON l.id = j.lead_id
          WHERE j.id = $1 AND ($2::text = 'admin' OR l.assigned_to = $3::uuid OR l.claimed_by = $3::uuid)`,
        [parsed.data.jobId, jobViewer.role, jobViewer.id],
      );
      if (!rows || rows.length === 0) {
        return reply.status(404).send({ error: 'Job not found' });
      }
      return { job: rows[0] };
    },
  );

  // Bulk claim: one atomic UPDATE wins per lead; losers are reported with
  // their current owner instead of silently skipped.
  fastify.post(
    '/bulk-claim',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const bodySchema = z.object({ lead_ids: z.array(z.string().uuid()).min(1).max(50) });
      const parseResult = bodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const me = req.user as { id: string };
      const sql = getDB();
      const won = (await sql.unsafe(
        `UPDATE leads SET claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
          WHERE id = ANY($2::uuid[]) AND claimed_by IS NULL RETURNING id`,
        [me.id, parseResult.data.lead_ids],
      )) as unknown as Array<{ id: string }>;
      const wonIds = new Set(won.map((r) => r.id));
      const lostIds = parseResult.data.lead_ids.filter((id) => !wonIds.has(id));
      let already: Array<Record<string, unknown>> = [];
      if (lostIds.length > 0) {
        already = (await sql.unsafe(
          `SELECT l.id, u.email AS claimed_by_email FROM leads l
            LEFT JOIN users u ON u.id = l.claimed_by WHERE l.id = ANY($1::uuid[])`,
          [lostIds],
        )) as unknown as Array<Record<string, unknown>>;
      }
      if (wonIds.size > 0) {
        await logAuditEvent({
          user_id: me.id, action: 'bulk_claim_lead', resource_type: 'lead',
          resource_id: '', details: { claimed: [...wonIds], skipped: lostIds },
        });
        await publishSSE(me.id, { type: 'leads_claimed', claimed: [...wonIds] });
      }
      return { claimed: [...wonIds], already_claimed: already };
    },
  );

  // Bulk assign (admin only): one UPDATE for the whole set + one audit event.
  fastify.patch(
    '/bulk-assign',
    { preValidation: [authorize(['admin'])] },
    async (req, reply) => {
      const bodySchema = z.object({
        lead_ids: z.array(z.string().uuid()).min(1).max(50),
        assigned_to: z.string().uuid().nullable(),
      });
      const parseResult = bodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      }
      const { lead_ids, assigned_to } = parseResult.data;
      const sql = getDB();
      if (assigned_to) {
        const user = await sql.unsafe(`SELECT id FROM users WHERE id = $1`, [assigned_to]);
        if (!user || (user as unknown[]).length === 0) {
          return reply.status(400).send({ error: 'Assigned user not found' });
        }
      }
      const rows = (await sql.unsafe(
        `UPDATE leads SET assigned_to = $1, updated_at = NOW()
          WHERE id = ANY($2::uuid[]) RETURNING id`,
        [assigned_to, lead_ids] as any,
      )) as unknown as Array<{ id: string }>;
      await logAuditEvent({
        user_id: (req.user as { id: string }).id, action: 'bulk_assign_lead',
        resource_type: 'lead', resource_id: '',
        details: { assigned_to: assigned_to || null, lead_ids: rows.map((r) => r.id) },
      });
      await publishSSE((req.user as { id: string }).id, {
        type: 'leads_assigned', assigned_to: assigned_to || null,
        lead_ids: rows.map((r) => r.id),
      });
      return { assigned: rows.map((r) => r.id), assigned_to: assigned_to || null };
    },
  );

  // CSV/TSV import with automatic dedup. The client parses the file (no multipart
  // dependency) and posts rows; the server maps headers onto canonical fields and
  // runs the same SRS §4.6 ladder the scrapers use, so re-importing a file, or
  // importing leads we already scraped, merges instead of duplicating.
  const importBodySchema = z.object({
    csv: z.string().min(1).optional(),
    rows: z.array(z.record(z.string(), z.string())).max(5000).optional(),
    dry_run: z.boolean().default(false),
  }).refine((b) => Boolean(b.csv) !== Boolean(b.rows), {
    message: 'Provide either `csv` text or `rows` (parsed records), not both',
  });

  fastify.post<{ Body: z.infer<typeof importBodySchema> }>(
    '/import',
    {
      preValidation: [authorize(['admin', 'sales_rep'])],
      // Per-user, generous-but-bounded: an import is a deliberate admin/rep action and a
      // real sheet now arrives as several chunks, so the previous 10/min made legitimate
      // multi-thousand-row files fail mid-way with 429. Still far below the global 100/min
      // for anonymous traffic, and keyed on the user id rather than IP so an office behind
      // one NAT does not share a bucket.
      config: {
        rateLimit: {
          max: Number(process.env.LEADS_IMPORT_MAX_PER_MIN ?? 60),
          timeWindow: '1 minute',
          keyGenerator: (req: any) => String(req.user?.id ?? req.ip),
        },
      },
    },
    async (req, reply) => {
      const parsed = importBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues });
      }
      const user = req.user as { id: string; role: string; email?: string };
      const sql = getDB();

      let result;
      try {
        result = parsed.data.csv
          ? await importCsvText(sql, parsed.data.csv, user, { dryRun: parsed.data.dry_run })
          : await importLeadRecords(sql, parsed.data.rows ?? [], user, { dryRun: parsed.data.dry_run });
      } catch (err: any) {
        const status = err?.statusCode ?? 500;
        if (status >= 500) throw err;
        return reply.status(status).send({ error: err?.message ?? 'Import failed' });
      }

      if (!parsed.data.dry_run && result.created + result.merged + result.merged_fuzzy > 0) {
        await logAuditEvent({
          user_id: user.id,
          action: 'import_leads',
          resource_type: 'lead',
          resource_id: '',
          details: {
            created: result.created, merged: result.merged,
            merged_fuzzy: result.merged_fuzzy, skipped: result.skipped,
            total_rows: result.total_rows,
          },
        });
        await publishSSE(user.id, { type: 'leads_imported', created: result.created, merged: result.merged });
      }

      return result;
    },
  );

  // Full-fidelity export of every lead matching the current filters -- not the 25
  // rows on screen. Emits SpreadsheetML 2003: opens natively in Excel/LibreOffice
  // with a styled frozen header, autofilter and column widths, without adding an
  // xlsx dependency for what is one template string.
  fastify.get(
    '/export',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const parseResult = paginationSchema.safeParse({
        ...(req.query as Record<string, unknown>), page: 1, limit: 200,
      });
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid query parameters' });
      }
      const q = parseResult.data;
      const format = (req.query as Record<string, unknown>).format === 'csv' ? 'csv' : 'xls';
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      const { conditions, values } = buildLeadFilters(q, user);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Bounded completeness: every lead matching the filters, up to EXPORT_MAX_ROWS.
      // Unbounded here would let one unfiltered admin request allocate the whole table as
      // a SpreadsheetML string; past the cap the response says so instead of lying silently.
      const EXPORT_MAX_ROWS = Number(process.env.LEADS_EXPORT_MAX_ROWS ?? 50000);
      const rows = await sql.unsafe(`
        SELECT ${LEAD_SELECT_SQL}
        ${LEAD_FROM_SQL}
        ${whereClause}
        ORDER BY l.lead_score DESC NULLS LAST, l.created_at DESC
        LIMIT ${EXPORT_MAX_ROWS + 1}
      `, values as any);
      const truncated = (rows as unknown[]).length > EXPORT_MAX_ROWS;
      if (truncated) rows.splice(EXPORT_MAX_ROWS);

      const xml = format === 'csv'
        ? buildLeadsCsv(rows as any[])
        : buildLeadsWorkbook(rows as any[], (user as any).email ?? '', truncated);
      return reply
        .header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel')
        .header('Content-Disposition',
          `attachment; filename="hiregen-leads-${new Date().toISOString().slice(0, 10)}.${format === 'csv' ? 'csv' : 'xls'}"`)
        .send(xml);
    },
  );

  fastify.get('/duplicates', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const sql = getDB();

    const candidates = await sql.unsafe(`
      SELECT l1.id as lead_id, l1.lead_score, l1.pipeline_stage, l1.created_at,
             c1.name as company_name, jp1.title as job_title, jp1.job_url as job_url,
             l2.id as duplicate_of_id, l2.lead_score as dup_score, l2.pipeline_stage as dup_stage,
             c2.name as dup_company_name, jp2.title as dup_job_title, jp2.job_url as dup_job_url
      FROM leads l1
      JOIN companies c1 ON l1.company_id = c1.id
      JOIN job_postings jp1 ON l1.job_posting_id = jp1.id
      JOIN leads l2 ON l1.possible_duplicate_of = l2.id
      JOIN companies c2 ON l2.company_id = c2.id
      JOIN job_postings jp2 ON l2.job_posting_id = jp2.id
      WHERE l1.possible_duplicate_of IS NOT NULL
      ORDER BY l1.created_at DESC
    `);

    const rows = (candidates as any[]).map((row) => ({
      lead_id: row.lead_id,
      lead_score: row.lead_score,
      pipeline_stage: row.pipeline_stage,
      created_at: row.created_at,
      company_name: row.company_name,
      job_title: row.job_title,
      duplicate_of_id: row.duplicate_of_id,
      dup_score: row.dup_score,
      dup_stage: row.dup_stage,
      dup_company_name: row.dup_company_name,
      dup_job_title: row.dup_job_title,
      similarity: calculateCandidateSimilarity(
        { companyName: row.company_name, jobTitle: row.job_title, jobUrl: row.job_url },
        { companyName: row.dup_company_name, jobTitle: row.dup_job_title, jobUrl: row.dup_job_url }
      ),
    }));

    return { duplicates: rows };
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/merge-duplicate',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const idResult = leadIdSchema.safeParse(req.params);
      if (!idResult.success) {
        return reply.status(400).send({ error: 'Invalid lead ID' });
      }
      const { id } = idResult.data;

      const bodySchema = z.object({
        merge_into_id: z.string().uuid(),
      });
      const parseResult = bodySchema.safeParse(req.body || {});
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'Invalid body' });
      }
      const { merge_into_id } = parseResult.data;

      if (id === merge_into_id) {
        return reply.status(400).send({ error: 'Cannot merge a lead into itself' });
      }

      const sql = getDB();
      const actor = req.user as { id: string; role: string };

      // Merging DELETES the source lead and re-parents its history onto the target, so it
      // is the most destructive lead operation here. Both rows must be the caller's
      // (admin excepted): previously either could be any UUID, letting one rep destroy
      // another's lead by guessing an id.
      const visible = await sql.unsafe(
        `SELECT id FROM leads
          WHERE id = ANY($1::uuid[]) AND ($2::text = 'admin' OR assigned_to = $3::uuid OR claimed_by = $3::uuid)`,
        [[id, merge_into_id], actor.role, actor.id] as any,
      );
      const allowed = new Set((visible as unknown as Array<{ id: string }>).map((r) => r.id));
      if (!allowed.has(id)) {
        return reply.status(404).send({ error: 'Lead not found' });
      }
      if (!allowed.has(merge_into_id)) {
        return reply.status(404).send({ error: 'Target lead not found' });
      }

      // Single transaction: any failure rolls back all re-parents + delete.
      // Falls back to sequential writes only when the DB client lacks
      // `.begin` (unit-test mock); production `postgres.Sql` always has it.
      const doMerge = async (tx: any) => {
        await tx.unsafe(
          `UPDATE enrichment_log SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        await tx.unsafe(
          `UPDATE verification_log SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        await tx.unsafe(
          `UPDATE outreach_drafts SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        await tx.unsafe(
          `UPDATE outreach_log SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        await tx.unsafe(
          `UPDATE enrichment_jobs SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        await tx.unsafe(
          `UPDATE inbound_messages SET lead_id = $1 WHERE lead_id = $2`,
          [merge_into_id, id],
        );
        // Clear dangling duplicate pointers at the deleted id so no row
        // references a lead that no longer exists.
        await tx.unsafe(
          `UPDATE leads SET possible_duplicate_of = NULL WHERE possible_duplicate_of = $1`,
          [id],
        );

        await tx.unsafe(`DELETE FROM leads WHERE id = $1`, [id]);
      };
      if (typeof (sql as any).begin === 'function') {
        await (sql as any).begin(doMerge);
      } else {
        await doMerge(sql);
      }

      await logAuditEvent({
        user_id: (req.user as { id: string }).id,
        action: 'merge_duplicate',
        resource_type: 'lead',
        resource_id: id,
        details: { merged_into: merge_into_id },
      });

      return { message: 'Merged', merged_from: id, merged_into: merge_into_id };
    },
  );
};
