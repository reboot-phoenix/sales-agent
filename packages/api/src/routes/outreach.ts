import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDB } from '../utils/db';
import { authenticate, authorize } from '../middleware/auth';
import { callWorker } from '../utils/worker';
import {
  CONTACT_SELECT,
  OUTREACH_DOMAINS,
  assessLead,
  rankAssessments,
  type OutreachAssessment,
  type OutreachContact,
  type OutreachDomain,
} from '../utils/outreach';

/**
 * The outreach surface: what to work on today, and why.
 *
 * Every lead is scored with the same rules the workers use (utils/outreach), so a
 * lead's priority never depends on which page asked. Rows are scored in batches
 * from one query each — never per-row — because the queue is expected to hold
 * hundreds of thousands of leads.
 */

// Per-domain projections keep the payload small: the queue shows what a rep acts
// on (who to contact, how to reach them), not every scraped field.
const LEAD_SELECT: Record<OutreachDomain, string> = {
  jobs: `
    l.id, jp.title AS name, c.name AS company_name, jp.location AS city, jp.remote_type,
    jp.posted_at, jp.apply_url AS website_url, l.completeness_score, l.contact_coverage,
    l.outreach_readiness, l.outreach_score, l.outreach_priority, l.outreach_assessed_at,
    l.pipeline_stage, l.lead_score, l.claimed_by, l.assigned_to, l.do_not_contact,
    l.created_at`,
  hackathons: `
    h.id, h.name, h.organizer_name, h.city, h.state, h.mode, h.event_start,
    h.registration_deadline, h.hackathon_url AS website_url, h.status,
    h.occurrence_type, h.completeness_score, h.outreach_readiness, h.outreach_score,
    h.outreach_priority, h.outreach_assessed_at, h.contact_name, h.contact_email,
    h.contact_phone, h.contact_linkedin, h.claimed_by, h.assigned_to, h.created_at`,
  colleges: `
    c.id, c.name, c.university_affiliation, c.city, c.state, c.website_url,
    c.institution_type, c.ownership, c.completeness_score, c.outreach_readiness,
    c.outreach_score, c.outreach_priority, c.outreach_assessed_at, c.tpo_name,
    c.tpo_email, c.tpo_phone, c.claimed_by, c.assigned_to, c.created_at`,
};

const LEAD_FROM: Record<OutreachDomain, string> = {
  jobs: `
    FROM leads l
    JOIN job_postings jp ON jp.id = l.job_posting_id
    JOIN companies c ON c.id = l.company_id`,
  hackathons: 'FROM hackathons h',
  colleges: 'FROM colleges c',
};

const queueSchema = z.object({
  domain: z.enum(['jobs', 'hackathons', 'colleges']).optional(),
  readiness: z
    .enum(['OUTREACH_READY', 'PARTIALLY_ENRICHED', 'NEEDS_ENRICHMENT', 'INSUFFICIENT_DATA'])
    .optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).optional(),
  state: z.string().optional(),
  q: z.string().optional(),
  min_score: z.coerce.number().min(0).max(100).optional(),
  // Only leads nobody owns: the queue is a worklist, and a rep must not be handed
  // a lead another rep already has.
  unclaimed_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
});

function contactOf(domain: OutreachDomain, row: Record<string, any>): OutreachContact[] {
  // Hackathon/college rows carry a denormalised best contact; job rows carry the
  // HR contact in the batch contact query. Both are mapped into one shape.
  const contacts: OutreachContact[] = [];
  if (Array.isArray(row.__contacts)) return row.__contacts as OutreachContact[];
  if (domain === 'hackathons' && (row.contact_email || row.contact_phone || row.contact_linkedin)) {
    contacts.push({
      email: row.contact_email,
      phone: row.contact_phone,
      linkedin_url: row.contact_linkedin,
      full_name: row.contact_name,
      role_category: 'organizer',
      verification_status: row.verification_status ?? 'unverified',
    });
  }
  if (domain === 'colleges' && (row.tpo_email || row.tpo_phone)) {
    contacts.push({
      email: row.tpo_email,
      phone: row.tpo_phone,
      full_name: row.tpo_name,
      role_category: 'tpo',
      verification_status: row.verification_status ?? 'unverified',
    });
  }
  return contacts;
}

async function loadContactMap(
  domain: OutreachDomain,
  ids: string[],
): Promise<Map<string, OutreachContact[]>> {
  const map = new Map<string, OutreachContact[]>();
  if (ids.length === 0) return map;
  const sql = getDB();
  const rows = (await sql.unsafe(CONTACT_SELECT[domain], [ids])) as any[];
  for (const row of rows) {
    const key = String(row.entity_id);
    const list = map.get(key) ?? [];
    list.push(row as OutreachContact);
    map.set(key, list);
  }
  return map;
}

export const outreachRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  /**
   * The sendable worklist. Rows already assessed by the workers are scored in
   * SQL; the rest are scored here so a freshly discovered lead never waits for
   * the next army run to appear.
   */
  fastify.get(
    '/queue',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const parsed = queueSchema.safeParse(req.query || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues });
      }
      const q = parsed.data;
      const user = req.user as { id: string; role: string };
      const sql = getDB();
      const domains: OutreachDomain[] = q.domain ? [q.domain] : [...OUTREACH_DOMAINS];

      const perDomain: OutreachAssessment[] = [];
      const meta = new Map<string, Record<string, any>>();
      for (const domain of domains) {
        const conditions: string[] = ['t.is_active IS NOT FALSE'];
        const values: unknown[] = [];
        const add = (template: string, ...vals: unknown[]) => {
          let text = template;
          for (const value of vals) {
            values.push(value);
            text = text.replace('?', `$${values.length}`);
          }
          conditions.push(text);
        };
        // A do-not-contact lead is never shown as sendable work.
        if (domain === 'jobs') conditions.push('l.do_not_contact IS NOT TRUE');
        // Readable rows only: owned, plus the unclaimed pool a rep may claim.
        if (user.role === 'sales_rep') {
          const alias = domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c';
          add(
            `(${alias}.assigned_to = ? OR ${alias}.claimed_by = ? OR (${alias}.claimed_by IS NULL AND ${alias}.assigned_to IS NULL))`,
            user.id, user.id,
          );
        }
        if (q.unclaimed_only === 'true') {
          const alias = domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c';
          conditions.push(`${alias}.claimed_by IS NULL AND ${alias}.assigned_to IS NULL`);
        }
        if (q.readiness) {
          const alias = domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c';
          add(`${alias}.outreach_readiness = ?`, q.readiness);
        }
        if (q.priority) {
          const alias = domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c';
          add(`${alias}.outreach_priority = ?`, q.priority);
        }
        if (q.state) {
          const alias = domain === 'jobs' ? 'jp.location' : domain === 'hackathons' ? 'h.state' : 'c.state';
          add(`${alias} ILIKE ?`, `%${q.state}%`);
        }
        if (q.q) {
          const like = `%${q.q}%`;
          if (domain === 'jobs') {
            add(`(jp.title ILIKE ? OR c.name ILIKE ?)`, like, like);
          } else if (domain === 'hackathons') {
            add(`(h.name ILIKE ? OR h.organizer_name ILIKE ?)`, like, like);
          } else {
            add(`(c.name ILIKE ? OR c.city ILIKE ?)`, like, like);
          }
        }
        if (q.min_score != null) {
          const alias = domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c';
          add(`${alias}.outreach_score >= ?`, q.min_score);
        }
        const where = `WHERE ${conditions.join(' AND ')}`;
        const rows = (await sql.unsafe(
          `SELECT ${LEAD_SELECT[domain]} ${LEAD_FROM[domain]} ${where} LIMIT ${q.limit}`,
          values as any,
        )) as any[];
        const contacts = await loadContactMap(domain, rows.map((row) => String(row.id)));
        for (const row of rows) {
          const rowContacts = contacts.get(String(row.id)) ?? contactOf(domain, row);
          const assessment = assessLead(domain, row, rowContacts);
          if (q.min_score != null && assessment.score < q.min_score) continue;
          perDomain.push(assessment);
          meta.set(`${domain}:${row.id}`, row);
        }
      }

      const ranked = rankAssessments(perDomain).slice(0, q.limit);
      return {
        data: ranked.map((assessment) => ({
          ...assessment,
          lead: meta.get(`${assessment.domain}:${assessment.entity_id}`) ?? null,
        })),
        counts: {
          assessed: perDomain.length,
          ready: perDomain.filter((a) => a.readiness === 'OUTREACH_READY').length,
          returned: ranked.length,
        },
      };
    },
  );

  /** Readiness mix per domain: the operations view of "are we sendable yet?". */
  fastify.get('/summary', async () => {
    const sql = getDB();
    const rows = (await sql.unsafe(`
      SELECT 'jobs' AS domain, outreach_readiness AS readiness, COUNT(*)::int AS count
        FROM leads WHERE do_not_contact IS NOT TRUE GROUP BY 2
      UNION ALL
      SELECT 'hackathons', outreach_readiness, COUNT(*)::int
        FROM hackathons WHERE is_active GROUP BY 2
      UNION ALL
      SELECT 'colleges', outreach_readiness, COUNT(*)::int
        FROM colleges WHERE is_active GROUP BY 2
    `)) as any[];
    const summary: Record<string, Record<string, number>> = {};
    for (const domain of OUTREACH_DOMAINS) summary[domain] = {};
    for (const row of rows) {
      const domain = String(row.domain);
      summary[domain] = { ...(summary[domain] ?? {}), [String(row.readiness)]: Number(row.count) };
    }
    const emailCoverage = (await sql.unsafe(`
      SELECT
        (SELECT COUNT(*)::int FROM leads WHERE do_not_contact IS NOT TRUE
           AND EXISTS (SELECT 1 FROM hr_contacts hc WHERE hc.id = leads.hr_contact_id
                        AND (hc.personal_email IS NOT NULL OR hc.personal_mobile IS NOT NULL))) AS jobs,
        (SELECT COUNT(*)::int FROM hackathons WHERE is_active
           AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL OR contact_linkedin IS NOT NULL)) AS hackathons,
        (SELECT COUNT(*)::int FROM colleges WHERE is_active
           AND EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = colleges.id)) AS colleges
    `)) as any[];
    return { readiness: summary, leads_with_a_locator: emailCoverage[0] ?? {} };
  });

  /** One lead's full assessment, including the reasons behind the number. */
  fastify.get<{ Params: { domain: string; id: string } }>(
    '/:domain/:id',
    async (req, reply) => {
      const domain = req.params.domain as OutreachDomain;
      if (!OUTREACH_DOMAINS.includes(domain)) {
        return reply.status(400).send({ error: 'unknown domain' });
      }
      const sql = getDB();
      const rows = (await sql.unsafe(
        `SELECT ${LEAD_SELECT[domain]} ${LEAD_FROM[domain]} WHERE ${domain === 'jobs' ? 'l' : domain === 'hackathons' ? 'h' : 'c'}.id = $1`,
        [req.params.id],
      )) as any[];
      if (rows.length === 0) return reply.status(404).send({ error: 'not found' });
      const contacts = await loadContactMap(domain, [req.params.id]);
      const assessment = assessLead(
        domain, rows[0], contacts.get(req.params.id) ?? contactOf(domain, rows[0]),
      );
      return { ...assessment, lead: rows[0] };
    },
  );

  /**
   * Ask the workers to re-check the deliverability of a lead's contacts and
   * re-score it. Synchronous by design: it re-reads rows we already stored.
   */
  fastify.post<{ Params: { domain: string; id: string } }>(
    '/:domain/:id/reassess',
    { preValidation: [authorize(['admin', 'sales_rep'])] },
    async (req, reply) => {
      const domain = req.params.domain as OutreachDomain;
      if (!OUTREACH_DOMAINS.includes(domain)) {
        return reply.status(400).send({ error: 'unknown domain' });
      }
      const worker = await callWorker(`/outreach/reassess`, {
        method: 'POST',
        body: { domain, id: req.params.id },
        timeoutMs: 60000,
      });
      if (!worker.ok) {
        // The lead is unchanged; say so rather than pretending it was refreshed.
        return reply.status(worker.status === 502 ? 503 : worker.status).send({
          error: 'reassessment unavailable',
          detail: worker.data,
        });
      }
      return worker.data;
    },
  );
};
