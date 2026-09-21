/**
 * Outreach readiness scoring, shared by every API surface that ranks leads.
 *
 * This mirrors `packages/scrapers/scrapers/domains/outreach.py`. The two must
 * agree, because the workers write a score onto the row and the API recomputes it
 * for rows that were never assessed — a divergence would mean the same lead has
 * two different priorities depending on who asked. Both sides are unit-tested
 * against the same documented rules, and the weights live here as constants so a
 * change is visible in one place.
 *
 * The rules, in order of importance:
 *   1. A URL is not reachability. Readiness requires a real locator.
 *   2. Only a *verified* locator can make a lead OUTREACH_READY.
 *   3. A failed locator scores zero. Sending to it would burn the lead.
 */

export type OutreachDomain = 'jobs' | 'hackathons' | 'colleges';

export const OUTREACH_DOMAINS: readonly OutreachDomain[] = ['jobs', 'hackathons', 'colleges'];

export type Readiness =
  | 'OUTREACH_READY'
  | 'PARTIALLY_ENRICHED'
  | 'NEEDS_ENRICHMENT'
  | 'INSUFFICIENT_DATA';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** Locator value, before role/freshness are added. */
export const LOCATOR_WEIGHTS = {
  verified_person_email: 40,
  verified_role_email: 30,
  verified_phone: 30,
  unverified_email: 12,
  unverified_phone: 10,
  linkedin: 15,
} as const;

export const ROLE_WEIGHTS: Record<OutreachDomain, Record<string, number>> = {
  colleges: {
    tpo: 30, placement_head: 28, placement_cell: 22, director: 18,
    principal: 16, dean: 12, hod: 10, official: 8, faculty: 6, other: 4,
  },
  hackathons: { organizer: 30, outreach: 26, sponsor: 18, judge: 8 },
  jobs: { hr: 30, recruiter: 26, hiring_manager: 22, other: 6 },
};

const VERIFIED_STATES = new Set(['verified', 'cross_verified']);
const DEAD_STATES = new Set(['failed', 'undeliverable', 'invalid', 'bounced']);

const ROLE_LOCAL_PARTS = new Set([
  'info', 'contact', 'admin', 'administrator', 'webmaster', 'postmaster',
  'noreply', 'no-reply', 'donotreply', 'abuse', 'support', 'helpdesk',
]);

/** Fields that make a lead worth sending to (mirrors DATA_POINT_KEYS in python). */
export const DATA_POINT_KEYS = [
  'city', 'state', 'website_url', 'description', 'skills', 'themes',
  'technology', 'company_name', 'organizer_name', 'university',
] as const;

export interface OutreachContact {
  email?: string | null;
  personal_email?: string | null;
  phone?: string | null;
  personal_mobile?: string | null;
  linkedin_url?: string | null;
  role_category?: string | null;
  role?: string | null;
  job_title?: string | null;
  designation?: string | null;
  full_name?: string | null;
  verification_status?: string | null;
  verification_grade?: string | null;
  priority?: string | null;
  id?: string;
  contact_source?: string | null;
  source_url?: string | null;
}

export interface OutreachAssessment {
  domain: OutreachDomain;
  entity_id: string;
  name: string;
  score: number;
  priority: Priority;
  readiness: Readiness;
  best_contact: OutreachContact | null;
  reasons: string[];
  blockers: string[];
}

/** Shared role mailboxes reach a desk, not a person, so they are worth less. */
export function isRoleAddress(email: string | null | undefined): boolean {
  if (!email || !email.includes('@')) return false;
  const local = email.split('@')[0].trim().toLowerCase().split('+')[0];
  if (!local) return false;
  if (ROLE_LOCAL_PARTS.has(local)) return true;
  return ['placement', 'tpo', 'principal', 'director', 'dean', 'hod', 'admission',
    'office', 'career', 'hr', 'recruit'].some((prefix) => local.startsWith(prefix));
}

/** Structural phone check; an all-same-digit filler is not a usable number. */
export function phoneWorthSending(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  return new Set(digits).size > 3;
}

const JOB_TITLE_RULES: Array<[string, string[]]> = [
  ['recruiter', ['recruit', 'talent acquisition', 'sourcer', 'staffing']],
  ['hr', ['hr ', 'hr/', 'human resource', 'people ops', 'people partner', 'hr business', 'chro']],
  ['hiring_manager', ['hiring manager', 'engineering manager', 'head of', 'director',
    'vp ', 'vice president', 'founder', 'cto', 'ceo', 'team lead', 'manager']],
];

export function contactRole(domain: OutreachDomain, contact: OutreachContact): string {
  const explicit = String(contact.role_category || contact.role || '').trim().toLowerCase();
  if (explicit) return explicit;
  const title = String(contact.job_title || contact.designation || '').trim().toLowerCase();
  if (!title) return '';
  if (domain === 'jobs') {
    for (const [role, needles] of JOB_TITLE_RULES) {
      if (needles.some((needle) => title.includes(needle))) return role;
    }
  }
  return 'other';
}

/** Score one contact by what it gives us and how much we trust it. */
export function contactLocatorScore(contact: OutreachContact): { score: number; reasons: string[] } {
  const status = String(contact.verification_status || 'unverified').toLowerCase();
  const reasons: string[] = [];
  if (DEAD_STATES.has(status)) {
    return { score: 0, reasons: ['locator failed verification - not usable for outreach'] };
  }
  const verified = VERIFIED_STATES.has(status);
  const email = String(contact.email || contact.personal_email || '').trim();
  const phone = String(contact.phone || contact.personal_mobile || '').trim();
  const linkedin = String(contact.linkedin_url || '').trim();
  let score = 0;

  if (email && verified) {
    if (isRoleAddress(email)) {
      score += LOCATOR_WEIGHTS.verified_role_email;
      reasons.push('verified role mailbox');
    } else {
      score += LOCATOR_WEIGHTS.verified_person_email;
      reasons.push('verified personal email');
    }
  } else if (email) {
    score += LOCATOR_WEIGHTS.unverified_email;
    reasons.push('unverified email (discovered, not deliverability-checked)');
  }
  if (phone && verified && phoneWorthSending(phone)) {
    score += LOCATOR_WEIGHTS.verified_phone;
    reasons.push('verified phone');
  } else if (phone && phoneWorthSending(phone)) {
    score += LOCATOR_WEIGHTS.unverified_phone;
    reasons.push('unverified phone');
  }
  if (linkedin) {
    score += LOCATOR_WEIGHTS.linkedin;
    reasons.push('public LinkedIn profile');
  }
  const grade = String(contact.verification_grade || '').toUpperCase().slice(0, 1);
  if (grade === 'A') score += 6;
  else if (grade === 'B') score += 3;
  return { score, reasons };
}

export function bestContact(contacts: OutreachContact[]): OutreachContact | null {
  let best: OutreachContact | null = null;
  let bestScore = 0;
  for (const contact of contacts) {
    const { score } = contactLocatorScore(contact);
    if (score > bestScore) {
      best = contact;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Whole days from start to end. Uses floor(elapsed time), while the python twin
 * works on calendar dates — so the two can differ by one day in a reason string.
 * The bucket boundaries they feed (3/14/45 days, 14/45 days) are identical, so a
 * lead never lands in a different urgency band depending on who scored it.
 */
function daysBetween(start: unknown, end: unknown): number | null {
  const toDate = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string') {
      const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  };
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

export function freshnessPoints(
  domain: OutreachDomain,
  record: Record<string, any>,
  now: Date = new Date(),
): { points: number; reasons: string[] } {
  if (domain === 'jobs') {
    const age = daysBetween(record.posted_at || record.discovered_at || record.created_at, now);
    if (age === null) return { points: 0, reasons: ['no posting date on record'] };
    if (age <= 3) return { points: 20, reasons: ['posted within 3 days'] };
    if (age <= 14) return { points: 14, reasons: ['posted within 2 weeks'] };
    if (age <= 45) return { points: 8, reasons: ['posted within 45 days'] };
    return { points: 0, reasons: ['posting is over 45 days old'] };
  }
  if (domain === 'hackathons') {
    const deadline = daysBetween(now, record.registration_deadline);
    if (deadline !== null && deadline >= 0) {
      if (deadline <= 14) return { points: 22, reasons: [`registration closes in ${deadline} day(s)`] };
      if (deadline <= 45) return { points: 14, reasons: ['registration window is open'] };
      return { points: 8, reasons: ['registration announced'] };
    }
    const start = daysBetween(now, record.event_start);
    if (start !== null && start >= 0) return { points: 6, reasons: ['event upcoming'] };
    const occurrence = String(record.occurrence_type || record.status || '').toUpperCase();
    if (occurrence.includes('PREDICTED') || occurrence.includes('RECURRING')) {
      return { points: 2, reasons: ['predicted recurrence (not a confirmed event)'] };
    }
    return { points: 0, reasons: ['no upcoming window on record'] };
  }
  const month = now.getUTCMonth() + 1;
  if (month >= 7 && month <= 12) return { points: 12, reasons: ['placement season in progress'] };
  if (month >= 4 && month <= 6) return { points: 8, reasons: ['pre-season (admissions) window'] };
  return { points: 4, reasons: ['off-season for placement outreach'] };
}

export function countDataPoints(record: Record<string, any>): number {
  return DATA_POINT_KEYS.filter((key) => {
    const value = record[key];
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }).length;
}

export function readinessFrom(input: {
  hasVerifiedLocator: boolean;
  locatorCount: number;
  completeness: number;
  dataPoints: number;
}): { readiness: Readiness; blockers: string[] } {
  if (input.hasVerifiedLocator && input.locatorCount >= 1 && input.dataPoints >= 1) {
    return { readiness: 'OUTREACH_READY', blockers: [] };
  }
  if (input.hasVerifiedLocator && input.locatorCount >= 1) {
    return {
      readiness: 'PARTIALLY_ENRICHED',
      blockers: ['lead record is thin — add context before sending'],
    };
  }
  if (input.locatorCount >= 1) {
    return {
      readiness: 'PARTIALLY_ENRICHED',
      blockers: ['locator discovered but not verified'],
    };
  }
  if (input.completeness >= 30) {
    return {
      readiness: 'NEEDS_ENRICHMENT',
      blockers: ['no reachable contact found on any public page'],
    };
  }
  return {
    readiness: 'INSUFFICIENT_DATA',
    blockers: ['almost nothing known about this record'],
  };
}

export function priorityFor(score: number, readiness: Readiness): Priority {
  if (readiness !== 'OUTREACH_READY' && readiness !== 'PARTIALLY_ENRICHED') {
    return score < 25 ? 'P4' : 'P3';
  }
  if (score >= 75) return 'P0';
  if (score >= 58) return 'P1';
  if (score >= 40) return 'P2';
  return 'P3';
}

/** Score one lead. Same rows in, same score out — no randomness, no clock drift. */
export function assessLead(
  domain: OutreachDomain,
  record: Record<string, any>,
  contacts: OutreachContact[],
  now: Date = new Date(),
): OutreachAssessment {
  if (!OUTREACH_DOMAINS.includes(domain)) throw new Error(`unknown outreach domain: ${domain}`);
  const reasons: string[] = [];
  const scored = contacts.map((contact) => ({ ...contactLocatorScore(contact), contact }));
  const locatorCount = scored.filter((entry) => entry.score > 0).length;
  const topScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0);

  if (topScore > 0) {
    const top = scored.filter((entry) => entry.score === topScore)[0];
    reasons.push(...top.reasons);
  } else if (scored.length > 0) {
    const notes = new Set<string>();
    for (const entry of scored) entry.reasons.forEach((note) => notes.add(note));
    reasons.push(...[...notes].sort().slice(0, 2));
  }

  const weights = ROLE_WEIGHTS[domain];
  let bestRole: string | null = null;
  let rolePoints = 0;
  for (const contact of contacts) {
    const role = contactRole(domain, contact);
    const weight = weights[role] ?? 0;
    if (weight > rolePoints) {
      bestRole = role;
      rolePoints = weight;
    }
  }
  if (bestRole) reasons.push(`reaches ${bestRole.replace(/_/g, ' ')}`);

  const fresh = freshnessPoints(domain, record, now);
  reasons.push(...fresh.reasons);

  const verifiedLocator = contacts.some(
    (contact) =>
      VERIFIED_STATES.has(String(contact.verification_status || '').toLowerCase()) &&
      Boolean(contact.email || contact.personal_email || contact.phone || contact.personal_mobile),
  );
  const completeness = Number(record.completeness_score || 0);
  const { readiness, blockers } = readinessFrom({
    hasVerifiedLocator: verifiedLocator,
    locatorCount,
    completeness,
    dataPoints: countDataPoints(record),
  });

  const score = Math.max(0, Math.min(100, topScore + rolePoints + fresh.points));
  return {
    domain,
    entity_id: String(record.id || ''),
    name: String(record.name || record.title || record.college_name || record.hackathon_name || '').slice(0, 200),
    score,
    priority: priorityFor(score, readiness),
    readiness,
    best_contact: bestContact(contacts),
    reasons: reasons.slice(0, 8),
    blockers,
  };
}

const READINESS_ORDER: Readiness[] = [
  'OUTREACH_READY', 'PARTIALLY_ENRICHED', 'NEEDS_ENRICHMENT', 'INSUFFICIENT_DATA',
];

/** Highest-value first; ties broken by readiness then name, so pages are stable. */
export function rankAssessments(assessments: OutreachAssessment[]): OutreachAssessment[] {
  return [...assessments].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byReadiness = READINESS_ORDER.indexOf(a.readiness) - READINESS_ORDER.indexOf(b.readiness);
    if (byReadiness !== 0) return byReadiness;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/** SQL fragment selecting the contacts an assessment needs, per domain. */
export const CONTACT_SELECT: Record<OutreachDomain, string> = {
  jobs: `SELECT l.id AS entity_id, hc.* FROM leads l
           JOIN hr_contacts hc ON hc.id = l.hr_contact_id
          WHERE l.id = ANY($1::uuid[])`,
  hackathons: `SELECT hackathon_id AS entity_id, * FROM hackathon_contacts
                WHERE hackathon_id = ANY($1::uuid[])`,
  colleges: `SELECT college_id AS entity_id, * FROM college_contacts
              WHERE college_id = ANY($1::uuid[])`,
};
