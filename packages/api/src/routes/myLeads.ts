import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate, authorize } from '../middleware/auth';
import { LEAD_SELECT_SQL } from '../utils/leadColumns';
import { LEAD_FROM_SQL } from '../utils/leadWorkbook';
import { toCsv } from '../utils/leadDomains';

/**
 * My Leads — three domain sections, never one generic table.
 *
 * Each endpoint returns only rows owned by the caller (claimed OR assigned),
 * filtered server-side. Reps are additionally scoped by RBAC; admins see their
 * own claimed/assigned work here (the full pool lives on each domain page).
 */
export const myLeadsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  const pageSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(200).default(25),
    q: z.string().optional(),
    filter: z.string().optional(),
  });

  fastify.get('/jobs', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = pageSchema.extend({
      pipeline_stage: z.string().optional(),
      freshness: z.enum(['fresh', 'recent', 'older', 'unknown']).optional(),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const values: unknown[] = [user.id];
    const conditions: string[] = [`(l.assigned_to = $1 OR l.claimed_by = $1)`];
    if (q.pipeline_stage) {
      values.push(q.pipeline_stage);
      conditions.push(`l.pipeline_stage = $${values.length}`);
    }
    if (q.freshness) {
      values.push(q.freshness);
      conditions.push(`jp.freshness_category = $${values.length}`);
    }
    const text = q.q || q.filter;
    if (text) {
      values.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      conditions.push(`(c.name ILIKE $${values.length} ESCAPE '\\' OR jp.title ILIKE $${values.length} ESCAPE '\\'
        OR hc.full_name ILIKE $${values.length} ESCAPE '\\' OR jp.city ILIKE $${values.length} ESCAPE '\\')`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (q.page - 1) * q.limit;
    const [countRow] = (await sql.unsafe(
      `SELECT COUNT(*)::int AS total ${LEAD_FROM_SQL} ${where}`,
      values as any,
    )) as any[];
    const rows = await sql.unsafe(
      `SELECT ${LEAD_SELECT_SQL} ${LEAD_FROM_SQL} ${where}
        ORDER BY l.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset] as any,
    );
    const total = Number(countRow?.total ?? 0);
    return { data: rows, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
  });

  fastify.get('/hackathons', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = pageSchema.extend({
      status: z.string().optional(),
      outreach_readiness: z.string().optional(),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const values: unknown[] = [user.id];
    const conditions: string[] = [`(h.assigned_to = $1 OR h.claimed_by = $1)`];
    if (q.status) {
      values.push(q.status);
      conditions.push(`h.status = $${values.length}`);
    }
    if (q.outreach_readiness) {
      values.push(q.outreach_readiness);
      conditions.push(`h.outreach_readiness = $${values.length}`);
    }
    const text = q.q || q.filter;
    if (text) {
      values.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      conditions.push(`(h.name ILIKE $${values.length} ESCAPE '\\' OR h.organizer_name ILIKE $${values.length} ESCAPE '\\'
        OR h.city ILIKE $${values.length} ESCAPE '\\' OR h.state ILIKE $${values.length} ESCAPE '\\')`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (q.page - 1) * q.limit;
    const [countRow] = (await sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM hackathons h ${where}`, values as any,
    )) as any[];
    const rows = await sql.unsafe(
      `SELECT h.*, cu.email AS claimed_by_email, au.email AS assigned_to_email
         FROM hackathons h
         LEFT JOIN users cu ON cu.id = h.claimed_by
         LEFT JOIN users au ON au.id = h.assigned_to
         ${where} ORDER BY h.created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset] as any,
    );
    const total = Number(countRow?.total ?? 0);
    return { data: rows, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
  });

  fastify.get('/colleges', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = pageSchema.extend({
      enrichment_status: z.string().optional(),
      outreach_readiness: z.string().optional(),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const q = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const values: unknown[] = [user.id];
    const conditions: string[] = [`(c.assigned_to = $1 OR c.claimed_by = $1)`];
    if (q.enrichment_status) {
      values.push(q.enrichment_status);
      conditions.push(`c.enrichment_status = $${values.length}`);
    }
    if (q.outreach_readiness) {
      values.push(q.outreach_readiness);
      conditions.push(`c.outreach_readiness = $${values.length}`);
    }
    const text = q.q || q.filter;
    if (text) {
      values.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      conditions.push(`(c.name ILIKE $${values.length} ESCAPE '\\' OR c.city ILIKE $${values.length} ESCAPE '\\'
        OR c.state ILIKE $${values.length} ESCAPE '\\' OR c.tpo_name ILIKE $${values.length} ESCAPE '\\')`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const offset = (q.page - 1) * q.limit;
    const [countRow] = (await sql.unsafe(
      `SELECT COUNT(*)::int AS total FROM colleges c ${where}`, values as any,
    )) as any[];
    const rows = await sql.unsafe(
      `SELECT c.*, cu.email AS claimed_by_email, au.email AS assigned_to_email,
              (SELECT COUNT(*)::int FROM college_contacts cc WHERE cc.college_id = c.id) AS contacts_count
         FROM colleges c
         LEFT JOIN users cu ON cu.id = c.claimed_by
         LEFT JOIN users au ON au.id = c.assigned_to
         ${where} ORDER BY c.created_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.limit, offset] as any,
    );
    const total = Number(countRow?.total ?? 0);
    return { data: rows, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } };
  });

  /**
   * Export exactly the viewer's own leads for one domain — the same ownership
   * rule as the list endpoints, so an export can never reveal a colleague's work.
   * Bounded by MY_LEADS_EXPORT_MAX_ROWS; past the cap the row count in the
   * response header shows the truncation instead of quietly dropping rows.
   */
  fastify.get('/export', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = z.object({
      domain: z.enum(['jobs', 'hackathons', 'colleges']),
      limit: z.coerce.number().min(1).max(50_000).default(10_000),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters' });
    const { domain, limit } = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();

    const queries: Record<string, { sql: string; columns: string[] }> = {
      jobs: {
        sql: `SELECT jp.title AS job_title, c.name AS company, jp.city, jp.state,
                     hc.full_name AS contact_name, hc.personal_email AS contact_email,
                     hc.personal_mobile AS contact_phone, hc.linkedin_url AS contact_linkedin,
                     l.email_status, l.whatsapp_status, l.outreach_readiness,
                     l.outreach_score, l.outreach_priority, l.pipeline_stage
                FROM leads l
                JOIN companies c ON c.id = l.company_id
                JOIN job_postings jp ON jp.id = l.job_posting_id
                LEFT JOIN hr_contacts hc ON hc.id = l.hr_contact_id
               WHERE (l.assigned_to = $1 OR l.claimed_by = $1)
               ORDER BY l.outreach_score DESC, l.created_at DESC LIMIT $2`,
        columns: ['job_title', 'company', 'city', 'state', 'contact_name', 'contact_email',
          'contact_phone', 'contact_linkedin', 'email_status', 'whatsapp_status',
          'outreach_readiness', 'outreach_score', 'outreach_priority', 'pipeline_stage'],
      },
      hackathons: {
        sql: `SELECT h.name, h.organizer_name, h.city, h.state, h.status, h.mode,
                     h.event_start, h.registration_deadline, h.contact_name, h.contact_email,
                     h.contact_phone, h.contact_linkedin, h.verification_status,
                     h.outreach_readiness, h.outreach_score, h.outreach_priority, h.outreach_status
                FROM hackathons h
               WHERE (h.assigned_to = $1 OR h.claimed_by = $1)
               ORDER BY h.outreach_score DESC, h.created_at DESC LIMIT $2`,
        columns: ['name', 'organizer_name', 'city', 'state', 'status', 'mode', 'event_start',
          'registration_deadline', 'contact_name', 'contact_email', 'contact_phone',
          'contact_linkedin', 'verification_status', 'outreach_readiness', 'outreach_score',
          'outreach_priority', 'outreach_status'],
      },
      colleges: {
        sql: `SELECT c.name, c.city, c.state, c.institution_type, c.ownership, c.website_url,
                     c.tpo_name, c.tpo_email, c.tpo_phone, c.principal_name, c.director_name,
                     c.verification_status, c.enrichment_status, c.outreach_readiness,
                     c.outreach_score, c.outreach_priority, c.outreach_status
                FROM colleges c
               WHERE (c.assigned_to = $1 OR c.claimed_by = $1)
               ORDER BY c.outreach_score DESC, c.created_at DESC LIMIT $2`,
        columns: ['name', 'city', 'state', 'institution_type', 'ownership', 'website_url',
          'tpo_name', 'tpo_email', 'tpo_phone', 'principal_name', 'director_name',
          'verification_status', 'enrichment_status', 'outreach_readiness', 'outreach_score',
          'outreach_priority', 'outreach_status'],
      },
    };

    const { sql: query, columns } = queries[domain];
    const rows = (await sql.unsafe(query, [user.id, limit])) as Array<Record<string, unknown>>;
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="my-${domain}-leads.csv"`);
    reply.header('X-Row-Count', String(rows.length));
    return toCsv(rows, columns);
  });

  fastify.get('/summary', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req) => {
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const [jobs, hackathons, colleges] = await Promise.all([
      sql.unsafe(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE l.pipeline_stage IN ('sent','delivered','replied','converted'))::int AS contacted,
                COUNT(*) FILTER (WHERE l.pipeline_stage = 'discovered')::int AS new_leads
           FROM leads l WHERE l.assigned_to = $1 OR l.claimed_by = $1`, [user.id],
      ),
      sql.unsafe(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE h.outreach_readiness = 'OUTREACH_READY')::int AS ready,
                COUNT(*) FILTER (WHERE h.status IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION'))::int AS predicted
           FROM hackathons h WHERE h.assigned_to = $1 OR h.claimed_by = $1`, [user.id],
      ),
      sql.unsafe(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE c.outreach_readiness = 'OUTREACH_READY')::int AS ready,
                COUNT(*) FILTER (WHERE c.enrichment_status = 'NEEDS_ENRICHMENT')::int AS needs_enrichment
           FROM colleges c WHERE c.assigned_to = $1 OR c.claimed_by = $1`, [user.id],
      ),
    ]);
    return { jobs: jobs[0], hackathons: hackathons[0], colleges: colleges[0] };
  });
};
