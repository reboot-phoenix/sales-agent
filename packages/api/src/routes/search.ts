import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate, authorize } from '../middleware/auth';
import { LEAD_FROM_SQL } from '../utils/leadWorkbook';

/**
 * Unified search across the domains, while keeping results domain-separated.
 *
 * RBAC is enforced per domain exactly as the domain list routes enforce it, so a
 * unified search can never surface a row the corresponding page would hide.
 */
export const searchRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  const schema = z.object({
    q: z.string().min(1).max(200),
    limit: z.coerce.number().min(1).max(50).default(10),
    domains: z.string().optional(),
  });

  function wantedDomains(raw?: string): Set<string> {
    const all = new Set(['jobs', 'hackathons', 'colleges', 'organizations']);
    if (!raw) return all;
    const picked = raw.split(',').map((d) => d.trim()).filter((d) => all.has(d));
    return picked.length ? new Set(picked) : all;
  }

  function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (m) => `\\${m}`);
  }

  fastify.get('/', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = schema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues });
    const { q, limit } = parsed.data;
    const domains = wantedDomains(parsed.data.domains);
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const like = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    const result: Record<string, unknown[]> = { jobs: [], hackathons: [], colleges: [], organizations: [] };

    if (domains.has('jobs')) {
      const scope = user.role === 'admin'
        ? ''
        : `AND (l.assigned_to = $3 OR l.claimed_by = $3 OR (l.claimed_by IS NULL AND l.assigned_to IS NULL))`;
      const params: unknown[] = [like, limit];
      if (user.role !== 'admin') params.push(user.id);
      result.jobs = await sql.unsafe(
        `SELECT l.id, c.name AS company_name, jp.title AS job_title, jp.city, jp.state,
                jp.source_site, l.lead_score, l.pipeline_stage,
                CASE WHEN c.name ILIKE $1 ESCAPE '\\' THEN 2 ELSE 1 END AS rank
           ${LEAD_FROM_SQL}
          WHERE (c.name ILIKE $1 ESCAPE '\\' OR jp.title ILIKE $1 ESCAPE '\\'
                 OR c.domain ILIKE $1 ESCAPE '\\' OR jp.city ILIKE $1 ESCAPE '\\'
                 OR hc.full_name ILIKE $1 ESCAPE '\\')
          ${scope}
          ORDER BY rank DESC, l.lead_score DESC, l.created_at DESC
          LIMIT $2`,
        params as any,
      );
    }
    if (domains.has('hackathons')) {
      const scope = user.role === 'admin'
        ? ''
        : `AND (h.assigned_to = $3 OR h.claimed_by = $3 OR (h.claimed_by IS NULL AND h.assigned_to IS NULL))`;
      const params: unknown[] = [prefix, limit];
      if (user.role !== 'admin') params.push(user.id);
      result.hackathons = await sql.unsafe(
        `SELECT h.id, h.name, h.organizer_name, h.status, h.mode, h.city, h.state,
                h.event_start, h.registration_deadline, h.confidence_score,
                CASE WHEN h.name ILIKE $1 ESCAPE '\\' THEN 2 ELSE 1 END AS rank
           FROM hackathons h
          WHERE (h.name ILIKE $1 ESCAPE '\\' OR h.organizer_name ILIKE $1 ESCAPE '\\'
                 OR h.technology ILIKE $1 ESCAPE '\\' OR h.city ILIKE $1 ESCAPE '\\'
                 OR h.state ILIKE $1 ESCAPE '\\')
          ${scope}
          ORDER BY rank DESC, h.confidence_score DESC, h.last_seen_at DESC
          LIMIT $2`,
        params as any,
      );
    }
    if (domains.has('colleges')) {
      const scope = user.role === 'admin'
        ? ''
        : `AND (c.assigned_to = $3 OR c.claimed_by = $3 OR (c.claimed_by IS NULL AND c.assigned_to IS NULL))`;
      const params: unknown[] = [prefix, limit];
      if (user.role !== 'admin') params.push(user.id);
      result.colleges = await sql.unsafe(
        `SELECT c.id, c.name, c.state, c.district, c.city, c.institution_type,
                c.ownership, c.website_url, c.enrichment_status, c.outreach_readiness,
                (SELECT COUNT(*)::int FROM college_contacts cc WHERE cc.college_id = c.id) AS contacts_count,
                CASE WHEN c.name ILIKE $1 ESCAPE '\\' THEN 2 ELSE 1 END AS rank
           FROM colleges c
          WHERE (c.name ILIKE $1 ESCAPE '\\' OR c.official_name ILIKE $1 ESCAPE '\\'
                 OR c.city ILIKE $1 ESCAPE '\\' OR c.district ILIKE $1 ESCAPE '\\'
                 OR c.state ILIKE $1 ESCAPE '\\' OR c.website_url ILIKE $1 ESCAPE '\\')
          ${scope}
          ORDER BY rank DESC, c.completeness_score DESC, c.last_seen_at DESC
          LIMIT $2`,
        params as any,
      );
    }
    if (domains.has('organizations')) {
      result.organizations = await sql.unsafe(
        `SELECT id, name, org_type, website_url, country, state, city
           FROM organizations
          WHERE name ILIKE $1 ESCAPE '\\' ORDER BY name LIMIT $2`,
        [`%${escapeLike(q)}%`, limit] as any,
      );
    }
    const counts = Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length]));
    return { query: q, counts, results: result };
  });

  // Lightweight autocomplete for the command bar.
  fastify.get('/suggest', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = schema.safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query' });
    const { q, limit } = parsed.data;
    const user = req.user as { id: string; role: string };
    const sql = getDB();
    const prefix = `${escapeLike(q)}%`;
    const [hackathons, colleges, companies] = await Promise.all([
      sql.unsafe(
        `SELECT h.name AS label, 'hackathon' AS domain, h.id
           FROM hackathons h WHERE h.name ILIKE $1 ESCAPE '\\'
          ${user.role === 'admin' ? '' : `AND (h.claimed_by = $3 OR h.assigned_to = $3 OR (h.claimed_by IS NULL AND h.assigned_to IS NULL))`}
          ORDER BY h.last_seen_at DESC LIMIT $2`,
        user.role === 'admin' ? [prefix, limit] : [prefix, limit, user.id],
      ),
      sql.unsafe(
        `SELECT c.name AS label, 'college' AS domain, c.id
           FROM colleges c WHERE c.name ILIKE $1 ESCAPE '\\'
          ${user.role === 'admin' ? '' : `AND (c.claimed_by = $3 OR c.assigned_to = $3 OR (c.claimed_by IS NULL AND c.assigned_to IS NULL))`}
          ORDER BY c.last_seen_at DESC LIMIT $2`,
        user.role === 'admin' ? [prefix, limit] : [prefix, limit, user.id],
      ),
      sql.unsafe(
        `SELECT name AS label, 'company' AS domain, id FROM companies
          WHERE name ILIKE $1 ESCAPE '\\' ORDER BY name LIMIT $2`,
        [prefix, limit],
      ),
    ]);
    return { suggestions: [...hackathons, ...colleges, ...companies] };
  });
};
