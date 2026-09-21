import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Analytics are computed in SQL over rows that actually exist. Figures are never
 * seeded, extrapolated or rounded into a claim the data does not support; an
 * empty domain returns zeros plus `measured: true` so the UI can say so plainly.
 */
export const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/jobs', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const [totals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS total_leads,
             COUNT(DISTINCT l.company_id)::int AS companies,
             COUNT(*) FILTER (WHERE hc.personal_email IS NOT NULL OR hc.personal_mobile IS NOT NULL)::int AS with_contact,
             COUNT(*) FILTER (WHERE jp.freshness_category = 'fresh')::int AS fresh,
             COUNT(*) FILTER (WHERE l.pipeline_stage IN ('sent','delivered','replied','converted'))::int AS contacted,
             COUNT(*) FILTER (WHERE l.pipeline_stage = 'replied')::int AS replied,
             COUNT(*) FILTER (WHERE l.pipeline_stage = 'converted')::int AS converted,
             ROUND(AVG(l.lead_score), 1) AS average_score
        FROM leads l
        JOIN job_postings jp ON jp.id = l.job_posting_id
        LEFT JOIN hr_contacts hc ON hc.id = l.hr_contact_id
    `)) as any[];
    const byBand = await sql.unsafe(`SELECT score_band AS value, COUNT(*)::int AS count FROM leads GROUP BY 1`);
    const byStage = await sql.unsafe(`SELECT pipeline_stage AS value, COUNT(*)::int AS count FROM leads GROUP BY 1 ORDER BY count DESC`);
    const bySource = await sql.unsafe(`SELECT source_site AS value, COUNT(*)::int AS count FROM job_postings GROUP BY 1 ORDER BY count DESC LIMIT 30`);
    const byLocation = await sql.unsafe(`
      SELECT COALESCE(city, state, location, 'unknown') AS value, COUNT(*)::int AS count
        FROM job_postings GROUP BY 1 ORDER BY count DESC LIMIT 25
    `);
    const byDay = await sql.unsafe(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM leads WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY 1
    `);
    const byExperience = await sql.unsafe(`
      SELECT COALESCE(experience_level, 'unknown') AS value, COUNT(*)::int AS count
        FROM job_postings GROUP BY 1 ORDER BY count DESC LIMIT 20
    `);
    const byEmployment = await sql.unsafe(`
      SELECT COALESCE(employment_type, 'unknown') AS value, COUNT(*)::int AS count
        FROM job_postings GROUP BY 1 ORDER BY count DESC
    `);
    return {
      measured: true,
      ...totals,
      by_score_band: byBand,
      by_stage: byStage,
      by_source: bySource,
      by_location: byLocation,
      by_day: byDay,
      by_experience: byExperience,
      by_employment_type: byEmployment,
    };
  });

  fastify.get('/hackathons', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const [totals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'HISTORICAL')::int AS historical,
             COUNT(*) FILTER (WHERE status IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN'))::int AS predicted,
             COUNT(*) FILTER (WHERE occurrence_type = 'recurring')::int AS recurring,
             COUNT(*) FILTER (WHERE registration_deadline >= NOW())::int AS registration_open,
             COUNT(DISTINCT organizer_name)::int AS organizers,
             ROUND(AVG(prize_pool) FILTER (WHERE prize_pool IS NOT NULL), 2) AS average_prize_pool
        FROM hackathons WHERE is_active
    `)) as any[];
    const byState = await sql.unsafe(`SELECT state AS value, COUNT(*)::int AS count FROM hackathons WHERE is_active AND state IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 30`);
    const byMonth = await sql.unsafe(`
      SELECT EXTRACT(MONTH FROM COALESCE(event_start, registration_start))::int AS month, COUNT(*)::int AS count
        FROM hackathons WHERE is_active AND COALESCE(event_start, registration_start) IS NOT NULL GROUP BY 1 ORDER BY 1
    `);
    const byTechnology = await sql.unsafe(`SELECT technology AS value, COUNT(*)::int AS count FROM hackathons WHERE is_active AND technology IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 20`);
    const organizers = await sql.unsafe(`
      SELECT organizer_name AS value, COUNT(*)::int AS count FROM hackathons
       WHERE is_active AND organizer_name IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT 25
    `);
    const prizeBuckets = await sql.unsafe(`
      SELECT CASE
               WHEN prize_pool IS NULL THEN 'unknown'
               WHEN prize_pool <= 50000 THEN 'under_50k'
               WHEN prize_pool <= 200000 THEN '50k_to_2L'
               WHEN prize_pool <= 500000 THEN '2L_to_5L'
               ELSE 'above_5L' END AS bucket,
             COUNT(*)::int AS count
        FROM hackathons WHERE is_active GROUP BY 1
    `);
    const [pending] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS pending_raw FROM raw_discovery_records
       WHERE domain = 'hackathons' AND status IN ('stored','processing','failed')
    `)) as any[];
    return { measured: true, ...totals, pending_raw: pending?.pending_raw ?? 0,
      by_state: byState, by_month: byMonth, by_technology: byTechnology,
      recurring_organizers: organizers, prize_buckets: prizeBuckets };
  });

  fastify.get('/colleges', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const [totals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS total,
             COUNT(DISTINCT state)::int AS states_covered,
             COUNT(DISTINCT district)::int AS districts_covered,
             COUNT(*) FILTER (WHERE website_url IS NOT NULL)::int AS with_website,
             COUNT(*) FILTER (WHERE enrichment_status = 'ENRICHED')::int AS enriched
        FROM colleges WHERE is_active
    `)) as any[];
    const [contactTotals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS contacts,
             COUNT(*) FILTER (WHERE role_category IN ('tpo','placement_head','placement_cell'))::int AS tpo_roles,
             COUNT(*) FILTER (WHERE role_category = 'principal')::int AS principals,
             COUNT(*) FILTER (WHERE email IS NOT NULL)::int AS emails,
             COUNT(*) FILTER (WHERE phone IS NOT NULL)::int AS phones
        FROM college_contacts
    `)) as any[];
    const byState = await sql.unsafe(`SELECT COALESCE(state,'unknown') AS value, COUNT(*)::int AS count FROM colleges WHERE is_active GROUP BY 1 ORDER BY count DESC LIMIT 40`);
    const byOwnership = await sql.unsafe(`SELECT COALESCE(ownership,'unknown') AS value, COUNT(*)::int AS count FROM colleges WHERE is_active GROUP BY 1`);
    const byReadiness = await sql.unsafe(`SELECT outreach_readiness AS value, COUNT(*)::int AS count FROM colleges WHERE is_active GROUP BY 1`);
    const byEnrichment = await sql.unsafe(`SELECT COALESCE(enrichment_status,'unknown') AS value, COUNT(*)::int AS count FROM colleges WHERE is_active GROUP BY 1`);
    const sourceCoverage = await sql.unsafe(`
      SELECT source_name AS value, COUNT(*)::int AS count FROM college_sources GROUP BY 1 ORDER BY count DESC LIMIT 20
    `);
    const [pending] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS pending_raw FROM raw_discovery_records
       WHERE domain = 'colleges' AND status IN ('stored','processing','failed')
    `)) as any[];
    return { measured: true, ...totals, contacts_total: contactTotals?.contacts ?? 0,
      tpo_roles: contactTotals?.tpo_roles ?? 0, principals: contactTotals?.principals ?? 0,
      contact_emails: contactTotals?.emails ?? 0, contact_phones: contactTotals?.phones ?? 0,
      pending_raw: pending?.pending_raw ?? 0,
      by_state: byState, by_ownership: byOwnership, by_outreach_readiness: byReadiness,
      by_enrichment_status: byEnrichment, by_source: sourceCoverage };
  });

  fastify.get('/scraper', { preValidation: [authorize(['admin', 'sales_rep'])] }, async () => {
    const sql = getDB();
    const [totals] = (await sql.unsafe(`
      SELECT COUNT(*)::int AS total_runs,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS successful_runs,
             COUNT(*) FILTER (WHERE status IN ('failed','partial'))::int AS failed_runs,
             COUNT(*) FILTER (WHERE status = 'running')::int AS running_runs,
             COALESCE(SUM(records_discovered),0)::int AS records_discovered,
             COALESCE(SUM(duplicates_removed),0)::int AS duplicates_removed,
             COALESCE(SUM(contacts_discovered),0)::int AS contacts_discovered,
             COALESCE(SUM(enrichments_done),0)::int AS enrichments_done,
             COALESCE(SUM(predictions_generated),0)::int AS predictions_generated,
             COALESCE(SUM(errors_count),0)::int AS errors,
             COALESCE(SUM(retries),0)::int AS retries
        FROM army_runs
    `)) as any[];
    const byDomain = await sql.unsafe(`
      SELECT domain AS value, COUNT(*)::int AS count,
             COALESCE(SUM(records_discovered),0)::int AS discovered
        FROM army_runs GROUP BY 1
    `);
    const recentRuns = await sql.unsafe(`
      SELECT id, domain, status, started_at, finished_at, records_discovered, records_inserted,
             contacts_discovered, errors_count
        FROM army_runs ORDER BY started_at DESC LIMIT 20
    `);
    const health = await sql.unsafe(`
      SELECT domain, name, health_status, enabled, tier, last_run_at, last_success_at,
             consecutive_failures, last_error
        FROM scraper_sources ORDER BY domain, name
    `);
    const recentErrors = await sql.unsafe(`
      SELECT run_id, domain, source, error, created_at FROM scraper_errors
       ORDER BY created_at DESC LIMIT 25
    `);
    const rawPending = await sql.unsafe(`
      SELECT domain AS value, COUNT(*)::int AS count FROM raw_discovery_records
       WHERE status IN ('stored','processing','failed') GROUP BY 1
    `);
    return { measured: true, ...totals, by_domain: byDomain, recent_runs: recentRuns,
      source_health: health, recent_errors: recentErrors, raw_pending: rawPending };
  });

  fastify.get('/snapshots', { preValidation: [authorize(['admin', 'sales_rep'])] }, async (req, reply) => {
    const parsed = z.object({
      domain: z.enum(['jobs', 'hackathons', 'colleges', 'scraper']).optional(),
      limit: z.coerce.number().min(1).max(100).default(10),
    }).safeParse(req.query || {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query' });
    const sql = getDB();
    const rows = parsed.data.domain
      ? await sql.unsafe(`SELECT * FROM analytics_snapshots WHERE domain = $1 ORDER BY generated_at DESC LIMIT $2`, [parsed.data.domain, parsed.data.limit])
      : await sql.unsafe(`SELECT * FROM analytics_snapshots ORDER BY generated_at DESC LIMIT $1`, [parsed.data.limit]);
    return { snapshots: rows };
  });
};
