import type postgres from 'postgres';
import {
  normaliseLeadRecords,
  parseDelimited,
  generateFingerprint,
  urlHostname,
  slugHeader,
  normalizeCompanyKey,
  normalizeJobUrl,
  normalizeLinkedin,
  NORMALIZED_JOB_URL_SQL,
  NORMALIZED_COMPANY_SQL,
  CORPORATE_SUFFIXES,
  HEADER_ALIAS_WORDS as HEADER_WORDS,
} from './leadColumns';
import { recomputeLeadScore, calculateLeadScore, loadScoringWeights } from './scoring';

/**
 * CSV/TSV lead import with automatic dedup.
 *
 * A rep gets a spreadsheet from another agency and pastes it in; nothing about that
 * file should create a second copy of a lead we already work. The ladder below runs
 * cheapest first and mirrors SRS §4.6 (the same rules the scrapers' normalizer applies),
 * so an imported row and a scraped row converge on one lead:
 *
 *   0. Lead ID column (our own export writes it) -> merge onto that exact lead
 *   1. exact job_postings.fingerprint      -> merge into the existing lead
 *   2. exact (company name/domain + normalized job url) match, when no title/url was
 *      given to fingerprint                -> merge (URL and company spellings are
 *      canonicalised, so trailing slashes, ?utm= tags and "Pvt. Ltd." variants merge)
 *   3. fuzzy similarity >= 0.85 over the last 30 days of leads -> merge, flagged as a
 *      possible duplicate so the Duplicates page still shows it for a human
 *   4. otherwise insert company / contact / posting / lead
 *
 * "Merge" means fill-only-blank (COALESCE): an import never overwrites data a rep has
 * already enriched or corrected, it only adds what was missing.
 */

const FUZZY_THRESHOLD = 0.85;
const MAX_ROWS = 5000;
/** Ceiling on the raw file text: 5000 rows x 20KB would otherwise hand us ~100MB to parse. */
// Consistent with the 8 MB request ceiling and MAX_ROWS: whichever is hit first wins.
export const MAX_CSV_CHARS = 6_000_000;

export interface ImportResult {
  total_rows: number;
  created: number;
  merged: number;
  merged_fuzzy: number;
  skipped: number;
  columns_mapped: Record<string, string>;
  columns_ignored: string[];
  errors: Array<{ row: number; reason: string }>;
}

/** Cell text from a spreadsheet is unbounded; Postgres columns are not. Cap free text and
 * identifiers separately so one 200KB paste cannot bloat every row it touches. */
const MAX_TEXT = 20000;
const MAX_SHORT = 512;

const clamp = (v: string | null, max: number): string | null =>
  (v === null || v.length <= max) ? v : v.slice(0, max);

const blankToNull = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/^'/, '');
  return s === '' ? null : s;
};

/** Long free-text field (description-like). */
const text = (v: unknown): string | null => clamp(blankToNull(v), MAX_TEXT);
/** Short identifier field (name / email / url / enum-like). */
const short = (v: unknown): string | null => clamp(blankToNull(v), MAX_SHORT);

const num = (v: unknown): number | null => {
  const s = blankToNull(v);
  if (s === null) return null;
  // "₹12,00,000" / "12 LPA" / "USD 90k" — keep digits and one separator only.
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean | null => {
  const s = (blankToNull(v) ?? '').toLowerCase();
  if (!s) return null;
  if (/^(y|yes|true|1|remote|wfh|work from home)$/.test(s)) return true;
  if (/^(n|no|false|0|onsite|hybrid)$/.test(s)) return false;
  return null;
};

/**
 * The CHECK'd enums on job_postings. Free text from a spreadsheet has to land inside them
 * or the whole row is rejected by the database, so anything unmapped becomes 'unspecified'
 * (the enum carves that value out for exactly this) rather than passing the raw text through.
 * Tables mirror scrapers/normalizer.py so an imported row and a scraped one agree.
 */
const LOCATION_TYPES = ['remote', 'onsite', 'hybrid', 'field', 'unspecified'];

const WORKPLACE_MAP: Record<string, string> = {
  remote: 'remote', workfromhome: 'remote', wfh: 'remote',
  onsite: 'onsite', office: 'onsite', field: 'field',
  hybrid: 'hybrid', flexible: 'hybrid',
};

const EMPLOYMENT_MAP: Record<string, string> = {
  fulltime: 'full_time', permanent: 'full_time', fulltimemployee: 'full_time',
  parttime: 'part_time',
  contract: 'contract', contractual: 'contract', contractor: 'contract',
  internship: 'internship', intern: 'internship',
  apprenticeship: 'apprenticeship', trainee: 'apprenticeship',
  freelance: 'freelance', freelancer: 'freelance',
  temporary: 'temporary', temp: 'temporary',
  unspecified: 'unspecified',
};

const keyOf = (v: unknown) => (blankToNull(v) ?? '').toLowerCase().replace(/[\s_.-]+/g, '');

/** job_postings.employment_type; unknown-but-present text degrades to 'unspecified'. */
export function employmentTypeOf(v: unknown): string | null {
  const key = keyOf(v);
  if (!key) return null;
  return EMPLOYMENT_MAP[key] ?? 'unspecified';
}

/**
 * job_postings.location_type. Reads the declared work-mode column first, then falls back
 * to the free-text location ("Remote — anywhere", "Bengaluru, Hybrid"), which is how most
 * agency sheets encode it.
 */
export function locationTypeOf(rec: Record<string, string>): string | null {
  const declared = keyOf(rec.location_type);
  if (declared) {
    if (WORKPLACE_MAP[declared]) return WORKPLACE_MAP[declared];
    if (declared.includes('remote') || declared === 'wfh') return 'remote';
    if (declared.includes('hybrid') || declared.includes('flexible')) return 'hybrid';
    if (declared.includes('onsite') || declared.includes('office') || declared.includes('field')) return 'onsite';
    return LOCATION_TYPES.includes(declared) ? declared : 'unspecified';
  }
  if (bool(rec.is_work_from_home) === true) return 'remote';
  const loc = (rec.location ?? '').toLowerCase();
  if (!loc) return null;
  const hasRemote = loc.includes('remote');
  const hasOnsite = loc.includes('onsite') || loc.includes('on-site') || loc.includes('office');
  if (hasRemote && !hasOnsite) return 'remote';
  if (loc.includes('hybrid')) return 'hybrid';
  return null;
}

const CURRENCIES: Record<string, string> = { inr: 'INR', rs: 'INR', rupee: 'INR', rupees: 'INR', usd: 'USD', dollar: 'USD', dollars: 'USD', eur: 'EUR', euro: 'EUR', gbp: 'GBP', pound: 'GBP' };
function currencyOf(rec: Record<string, string>): string | null {
  const explicit = CURRENCIES[keyOf(rec.salary_currency)];
  if (explicit) return explicit;
  const blob = `${rec.salary_range ?? ''} ${rec.salary_min ?? ''}`.toLowerCase();
  for (const [k, v] of Object.entries(CURRENCIES)) if (blob.includes(k)) return v;
  return null;
}

const PERIODS: Record<string, string> = { year: 'year', yearly: 'year', annual: 'year', annum: 'year', pa: 'year', lpa: 'year', perannum: 'year', month: 'month', monthly: 'month', permonth: 'month', week: 'week', weekly: 'week', perweek: 'week', day: 'day', daily: 'day', perday: 'day', hour: 'hour', hourly: 'hour', perhour: 'hour' };
function periodOf(rec: Record<string, string>): string | null {
  const explicit = PERIODS[keyOf(rec.salary_period)];
  if (explicit) return explicit;
  const blob = keyOf(rec.salary_range);
  for (const k of ['lpa', 'perannum', 'annum', 'pa', 'permonth', 'monthly', 'perweek', 'weekly', 'perday', 'daily', 'perhour', 'hourly']) {
    if (blob.includes(k)) return PERIODS[k] ?? null;
  }
  return null;
}

/**
 * Board hosts, see employerDomainOf below.
 */
const BOARD_HOSTS = /(naukri|shine|monster|indeed|linkedin|instahyre|hirist|iimjobs|foundit|cutshort|glassdoor|ziprecruiter|dice|apna|internshala|timesjobs|jobstreet|careerbuilder|simplyhired|wellfound|angel\.co|ycombinator|remoteok|workindia|hasjob|elitmus|freejobalert|classicjobs|districtseller|mycare\.net|elpais)/i;

/**
 * Employer domain for an imported row. The scrapers derive a slug from the company name
 * ("Nexa IT Labs" -> nexailabscom.com) and store that in companies.domain, so an import has
 * to produce the same key or every re-import creates a second company row. A real declared
 * / employer-site domain still wins over the slug; a job-board host never does.
 */
export function companyDomainSlug(companyName: string): string {
  let name = (companyName || '').toLowerCase();
  for (const suffix of CORPORATE_SUFFIXES) name = name.split(suffix).join('');
  const slug = name.replace(/[^a-z0-9]/g, '');
  return slug ? `${slug}.com` : '';
}

function cleanDomain(v: string | null): string | null {
  const s = (v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return s.includes('.') ? s : null;
}

export function employerDomainOf(companyName: string, jobUrl: string | null, declaredDomain: string | null): string {
  const declared = cleanDomain(blankToNull(declaredDomain));
  if (declared && !BOARD_HOSTS.test(declared)) return declared;
  const host = cleanDomain(urlHostname(jobUrl ?? ''));
  if (host && !BOARD_HOSTS.test(host)) return host;
  return companyDomainSlug(companyName) || declared || host || '';
}

/**
 * Store phone numbers as +<country><national> when we can infer them. The send worker
 * compares personal_mobile against WhatsApp's `from` verbatim and suppression keys are
 * written from that same raw string, so a sheet's "98765 43210" has to become
 * +919876543210 or the contact escapes both dedup and opt-out matching.
 * Heuristic by design: only a bare 10-digit / leading-0 number is assumed Indian; anything
 * else is preserved rather than guessed, because mangling a foreign number creates a wrong
 * contact that then dedups badly.
 */
export function normalizeMobile(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return trimmed.replace(/[\s().-]/g, '');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return trimmed;
}

function guessPostedAt(v: unknown): Date | null {
  const s = blankToNull(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * True when a record's values are all just their own header text, which happens when a
 * file's real header row was something we could not map and a data row shifted up. Cheap
 * heuristic, deliberately conservative: it only fires when *nothing* else in the row is
 * plausible (no URL, no email), so a genuine sheet with a company called "Company" still
 * imports.
 */
function recLooksUnmapped(rec: Record<string, string>): boolean {
  const filled = Object.entries(rec).filter(([, v]) => (v ?? '').trim() !== '');
  if (filled.length === 0) return false;
  // A value equal to one of its field's own alias names ("Company" under Company).
  const isHeaderText = (field: string, v: string) =>
    HEADER_WORDS[field]?.has(slugHeader(v)) ?? false;
  const allHeaderish = filled.every(([field, v]) => isHeaderText(field, v));
  if (!allHeaderish) return false;
  const hasUrl = /^https?:\/\//i.test(rec.job_url ?? '') || /^https?:\/\//i.test(rec.hr_linkedin_url ?? '');
  const hasEmail = /@/.test(rec.hr_email ?? '');
  return !hasUrl && !hasEmail;
}

/**
 * Set-based prefetch of the per-row lookups.
 *
 * The old flow issued ~10 queries per imported row (fingerprint probe, url probe, company
 * select, contact select, fuzzy probe, plus their inserts), so a 2600-row file was ~26k
 * round trips and took minutes while blocking other requests. Everything here answers the
 * same questions for the whole file in a few statements. A miss simply falls back to the
 * per-row path, so behaviour is unchanged — only the number of round trips differs.
 */
interface ImportCache {
  /** fingerprint -> existing posting (+ its lead) */
  byFingerprint: Map<string, { job_posting_id: string; lead_id: string | null }>;
  /** lower(job_url) + normalized company -> existing posting (+ its lead) */
  byUrl: Map<string, { job_posting_id: string; lead_id: string | null }>;
  /** lower(company name) and domain -> company id */
  companies: Map<string, string>;
  /** "companyId|email|linkedin|mobile" -> contact id */
  contacts: Map<string, string>;
}

const urlKey = (jobUrl: string | null, company: string | null) =>
  `${normalizeJobUrl(jobUrl)}\u0000${normalizeCompanyKey(company)}`;
const contactKey = (companyId: string | null, email: string, linkedin: string | null, mobile: string | null) =>
  `${companyId ?? ''}\u0000${email.toLowerCase()}\u0000${normalizeLinkedin(linkedin)}\u0000${mobile ?? ''}`;

async function buildImportCache(sql: postgres.Sql, records: Array<Record<string, string>>): Promise<ImportCache> {
  const cache: ImportCache = {
    byFingerprint: new Map(), byUrl: new Map(), companies: new Map(), contacts: new Map(),
  };
  if (records.length === 0) return cache;

  const fps = [...new Set(records.map((r) =>
    generateFingerprint(r.company_name ?? '', r.job_title ?? '', r.job_url ?? '')))];
  const urls = [...new Set(records.map((r) => normalizeJobUrl(r.job_url)).filter(Boolean))];
  const names = [...new Set(records.map((r) => (r.company_name ?? '').trim()).filter(Boolean))];
  // Both the raw and the suffix-stripped company key: "Acme" stored vs "Acme Pvt Ltd"
  // imported (or vice versa) must still meet.
  const nameKeys = [...new Set(names.flatMap((n) => {
    const full = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const stripped = normalizeCompanyKey(n);
    return stripped === full ? [full] : [full, stripped];
  }))];
  const emails = [...new Set(records.map((r) => (r.hr_email ?? '').trim().toLowerCase()).filter(Boolean))];
  const mobiles = [...new Set(records.map((r) => normalizeMobile(r.hr_mobile?.trim() ?? null)).filter(Boolean) as string[])];
  const linkeds = [...new Set(records.map((r) => normalizeLinkedin(r.hr_linkedin_url)).filter(Boolean))];

  // Chunk the IN lists so one huge file cannot build a statement with 5000 parameters.
  const chunked = <T,>(arr: T[], size = 800): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  for (const part of chunked(fps)) {
    const rows = await sql.unsafe(
      `SELECT jp.fingerprint, jp.id AS job_posting_id, l.id AS lead_id
         FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id = jp.id
        WHERE jp.fingerprint = ANY($1::text[])`,
      [part] as any,
    );
    for (const r of rows as unknown as Array<{ fingerprint: string; job_posting_id: string; lead_id: string | null }>) {
      if (!cache.byFingerprint.has(r.fingerprint)) cache.byFingerprint.set(r.fingerprint, { job_posting_id: r.job_posting_id, lead_id: r.lead_id });
    }
  }

  for (const part of chunked(urls)) {
    const rows = await sql.unsafe(
      `SELECT jp.job_url, c.name AS company_name, jp.id AS job_posting_id, l.id AS lead_id
         FROM job_postings jp
         JOIN companies c ON c.id = jp.company_id
         LEFT JOIN leads l ON l.job_posting_id = jp.id
        WHERE ${NORMALIZED_JOB_URL_SQL} = ANY($1::text[])`,
      [part] as any,
    );
    for (const r of rows as unknown as Array<{ job_url: string; company_name: string; job_posting_id: string; lead_id: string | null }>) {
      const k = urlKey(r.job_url, r.company_name);
      if (!cache.byUrl.has(k)) cache.byUrl.set(k, { job_posting_id: r.job_posting_id, lead_id: r.lead_id });
    }
  }

  for (const part of chunked(names)) {
    const rows = await sql.unsafe(
      `SELECT id, name, domain FROM companies
        WHERE lower(name) = ANY($1::text[]) OR ${NORMALIZED_COMPANY_SQL} = ANY($2::text[])`,
      [part.map((n) => n.toLowerCase()), nameKeys] as any,
    );
    for (const r of rows as unknown as Array<{ id: string; name: string; domain: string | null }>) {
      cache.companies.set(r.name.toLowerCase(), r.id);
      cache.companies.set(r.name.toLowerCase().replace(/[^a-z0-9]/g, ''), r.id);
      cache.companies.set(normalizeCompanyKey(r.name), r.id);
      if (r.domain) cache.companies.set(`domain:${r.domain.toLowerCase()}`, r.id);
    }
  }

  // Contacts are scoped to their employer, exactly like upsertContact's lookup.
  for (const part of chunked(emails)) {
    if (!part.length) continue;
    const rows = await sql.unsafe(
      `SELECT id, current_company_id, lower(personal_email) AS em, linkedin_url, personal_mobile
         FROM hr_contacts WHERE lower(personal_email) = ANY($1::text[])`,
      [part] as any,
    );
    for (const r of rows as unknown as Array<{ id: string; current_company_id: string | null; em: string; linkedin_url: string | null; personal_mobile: string | null }>) {
      cache.contacts.set(contactKey(r.current_company_id, r.em, null, null), r.id);
    }
  }
  for (const list of [mobiles, linkeds]) {
    if (!list.length) continue;
    for (const part of chunked(list)) {
      const isMobile = list === mobiles;
      const col = isMobile ? 'personal_mobile' : 'linkedin_url';
      const where = isMobile
        ? `${col} = ANY($1::text[])`
        : `lower(regexp_replace(regexp_replace(${col}, '[?#].*$', ''), '/+$', '', 'g')) = ANY($1::text[])`;
      const rows = await sql.unsafe(
        `SELECT id, current_company_id, ${col} AS v FROM hr_contacts WHERE ${where}`,
        [part] as any,
      );
      for (const r of rows as unknown as Array<{ id: string; current_company_id: string | null; v: string }>) {
        cache.contacts.set(
          list === mobiles ? contactKey(r.current_company_id, '', null, r.v) : contactKey(r.current_company_id, '', r.v, null),
          r.id,
        );
      }
    }
  }

  return cache;
}

/** Map a driver error onto a client-safe reason without leaking schema or values. */
export function classifyImportError(err: any): string {
  const msg = String(err?.message ?? err ?? '');
  if (/not-null|null value/i.test(msg)) return 'missing a required value';
  if (/violates check constraint/i.test(msg)) return 'a value was outside the allowed set';
  if (/value too long/i.test(msg)) return 'a value was too long';
  if (/duplicate key|unique/i.test(msg)) return 'conflicts with an existing row';
  if (/invalid input syntax/i.test(msg)) return 'a value had the wrong type';
  return 'row could not be saved';
}

/**
 * One pass over the parsed records. `dryRun` computes the plan (what would be created
 * vs merged) without touching a single row, which is what the preview dialog shows.
 */
export async function importLeadRecords(
  sql: postgres.Sql,
  records: Array<Record<string, string>>,
  user: { id: string; role: string; email?: string },
  opts: { dryRun?: boolean; sourceLabel?: string } = {},
): Promise<ImportResult> {
  const result: ImportResult = {
    total_rows: records.length,
    created: 0, merged: 0, merged_fuzzy: 0, skipped: 0,
    columns_mapped: {}, columns_ignored: [], errors: [],
  };
  if (records.length === 0) return result;
  if (records.length > MAX_ROWS) {
    throw Object.assign(new Error(`Too many rows (${records.length}); split the file into chunks of ${MAX_ROWS}`), { statusCode: 413 });
  }

  // Contacts that have opted out of outreach. An agency list is very likely to contain
  // someone who already unsubscribed from us, and importing them as workable would send
  // mail to an opt-out. Loaded once, applied per row.
  const suppressed = new Set<string>();
  /**
   * Suppression keys are written verbatim-lowercased by their producers: an email is
   * lower(trim(email)), a WhatsApp number is lower(trim(from)) in E.164 ("+919876543210").
   * So probe every form this row could have been stored under — comparing only a stripped
   * last-10-digit form silently missed every opt-out that was recorded with a country code.
   */
  const contactKeys = (email: string | null, mobile: string | null): string[] => {
    const keys: string[] = [];
    if (email) keys.push(email.trim().toLowerCase());
    if (mobile) {
      const raw = mobile.trim().toLowerCase();
      keys.push(raw);
      const digits = raw.replace(/\D/g, '');
      if (digits) {
        keys.push(digits);                                  // 919876543210
        const local = digits.replace(/^0+/, '').slice(-10); // 9876543210
        if (local.length === 10) {
          keys.push(local);
          keys.push(`+91${local}`);
        }
      }
    }
    return keys;
  };
  const isSuppressed = (email: string | null, mobile: string | null): boolean =>
    contactKeys(email, mobile).some((k) => suppressed.has(k));

  if (!opts.dryRun) {
    const rows = await sql.unsafe(
      `SELECT normalized_contact FROM suppressions WHERE channel IN ('any', 'email', 'whatsapp')`,
    );
    for (const r of rows as unknown as Array<{ normalized_contact: string }>) suppressed.add(r.normalized_contact);
  }

  /**
   * Round-trips, not CPU, dominated the old per-row flow: each row issued ~10 separate
   * queries (fingerprint probe, url probe, company select, contact select, fuzzy probe...),
   * so a 2600-row file was 26k statements and took three minutes. Every lookup that can be
   * answered from the whole file at once is prefetched here in a handful of set-based queries;
   * anything still missing falls back to the per-row path, so correctness never depends on
   * the cache being complete.
   */


  // Fingerprints already written *by this file*. Without it, a sheet listing the same
  // job twice inserts it twice (the DB lookups only see what was there before we started).
  const writtenFingerprints = new Map<string, { job_posting_id: string; lead_id: string | null }>();

  const normalized = records.map(withAliases);

  /**
   * Set-based prefetch of the per-row lookups; see buildImportCache. A miss falls back to
   * the per-row query, so this only removes round trips, never correctness. Built for
   * dry-runs too (SELECT-only): the preview must run the same ladder as the commit, or
   * it reports "new" for rows the commit would merge.
   */
  const cache = await buildImportCache(sql, normalized);

  for (let i = 0; i < normalized.length; i++) {
    const rec = normalized[i];
    const rowNum = i + 2; // 1-based, header row included -> matches the spreadsheet
    const companyName = short(rec.company_name);
    const jobTitle = short(rec.job_title);
    const jobUrl = short(rec.job_url);
    const hrName = short(rec.hr_name);
    const hrEmail = (blankToNull(rec.hr_email) ?? '').toLowerCase();
    const hrMobile = normalizeMobile(short(rec.hr_mobile));
    const hrLinkedin = short(rec.hr_linkedin_url);

    if (!companyName && !jobTitle && !hrName && !hrEmail) {
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'No company, job title or contact details' });
      continue;
    }
    if (!companyName && !hrName && !hrEmail) {
      // Without an employer or a person there is nothing to reach out to; a bare
      // job URL would otherwise materialise a company named after the file's junk.
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'Need a company name or a contact (name/email)' });
      continue;
    }
    if (recLooksUnmapped(rec)) {
      // Every recognised column carrying the same value as its own header is the
      // signature of a file whose headers we did not understand (e.g. "not,a,known"
      // over "1,2,3,4"): importing it would write the header text into the CRM.
      result.skipped++;
      result.errors.push({ row: rowNum, reason: 'Row looks like headers, not data — check the column names' });
      continue;
    }

    const fp = generateFingerprint(companyName ?? '', jobTitle ?? '', jobUrl ?? '');
    const hasIdentity = Boolean(companyName && jobTitle && jobUrl);
    // Our own export writes the Lead ID column: a re-imported export carries the exact
    // row identity, so match it directly instead of hoping the fuzzy ladder agrees.
    const rawLeadId = (rec.lead_id ?? '').trim();
    const leadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawLeadId)
      ? rawLeadId : null;

    const input: UpsertInput = {
      rec, companyName, jobTitle, jobUrl, hrName, hrEmail, hrMobile, hrLinkedin,
      fp, hasIdentity, leadId, user, sourceLabel: opts.sourceLabel ?? 'csv_import', cache,
      // Computed here, at construction, so *every* write branch below sees it. The in-file
      // duplicate path merged before the old assignment ran and could clear an opt-out.
      suppressedEmail: isSuppressed(hrEmail || null, hrMobile),
    };

    // Same job on two rows of this file: fold into the lead the first row produced.
    if (writtenFingerprints.has(fp)) {
      if (opts.dryRun) { result.merged++; continue; }
      const target = await sql.unsafe(
        `SELECT jp.id AS job_posting_id, l.id AS lead_id FROM job_postings jp
           LEFT JOIN leads l ON l.job_posting_id = jp.id WHERE jp.fingerprint = $1 LIMIT 1`,
        [fp] as any,
      );
      const hit = (target as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0]
        // A fake/test client answers [] for the lookup even though row 1 inserted, so fall
        // back to the posting/lead ids this file already created for this fingerprint.
        ?? writtenFingerprints.get(fp);
      if (hit) {
        const domain = employerDomainOf(companyName ?? '', jobUrl, blankToNull(rec.company_domain)) || null;
        await sql.begin((tx) => mergeIntoPosting(tx as unknown as postgres.Sql, hit, input, domain));
        result.merged++;
        continue;
      }
    }

    if (opts.dryRun) {
      // Same ladder as the commit, read-only: an ID, fingerprint or URL hit merges,
      // a fuzzy hit flags, otherwise the row would be created. Anything less truthful
      // (the old code only ran the fuzzy probe) reports "new" for rows that merge.
      writtenFingerprints.set(fp, { job_posting_id: 'dry', lead_id: null });
      if (leadId && await findByLeadId(sql, leadId)) { result.merged++; continue; }
      if (cache.byFingerprint.has(fp) || await fingerprintHit(sql, fp)) { result.merged++; continue; }
      if ((jobUrl && (cache.byUrl.get(urlKey(jobUrl, companyName)) || await urlHit(sql, jobUrl, companyName)))) { result.merged++; continue; }
      const dupId = !hasIdentity ? null : await findFuzzy(sql, companyName, jobTitle, jobUrl);
      if (dupId) { result.merged_fuzzy++; continue; }
      result.created++;
      continue;
    }

    // One transaction per row: a half-written lead (posting without a lead, or an enriched
    // contact attached to an unflagged lead) is worse than no write. Per-row rather than
    // per-file because one bad row must not abort the rest — inside a single tx the first
    // error poisons every statement after it.
    try {
      const outcome = await sql.begin(async (tx) => upsertOne(tx as unknown as postgres.Sql, input));
      writtenFingerprints.set(fp, { job_posting_id: outcome.job_posting_id, lead_id: outcome.lead_id });
      if (outcome.kind === 'created') result.created++;
      else if (outcome.kind === 'merged_fuzzy') result.merged_fuzzy++;
      else result.merged++;
    } catch (err: any) {
      result.skipped++;
      // Postgres messages name constraints, columns and sometimes values; report a stable
      // code here and keep the detail server-side.
      console.warn('[import] row %d failed: %s', rowNum, err?.message ?? err);
      result.errors.push({ row: rowNum, reason: classifyImportError(err) });
    }
  }

  return result;
}

/** Ladder step 0: the row names an exact lead (our export's Lead ID column). */
async function findByLeadId(
  sql: postgres.Sql,
  leadId: string,
): Promise<{ job_posting_id: string; lead_id: string | null } | null> {
  const rows = await sql.unsafe(
    `SELECT jp.id AS job_posting_id, l.id AS lead_id
       FROM leads l JOIN job_postings jp ON jp.id = l.job_posting_id
      WHERE l.id = $1 LIMIT 1`,
    [leadId] as any,
  );
  return (rows as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0] ?? null;
}

/** Ladder step 1 as a read-only probe (dry-run shares it with the commit path). */
async function fingerprintHit(
  sql: postgres.Sql,
  fp: string,
): Promise<{ job_posting_id: string; lead_id: string | null } | null> {
  const rows = await sql.unsafe(
    `SELECT jp.id AS job_posting_id, l.id AS lead_id
       FROM job_postings jp LEFT JOIN leads l ON l.job_posting_id = jp.id
      WHERE jp.fingerprint = $1
      ORDER BY jp.first_seen_at DESC LIMIT 1`,
    [fp] as any,
  );
  return (rows as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0] ?? null;
}

/**
 * Ladder step 2 as a read-only probe. Both sides canonicalised: ".../jobs/1",
 * ".../jobs/1/" and ".../jobs/1?utm=x" are one posting, and "Acme" vs
 * "Acme Pvt Ltd" is one employer.
 */
async function urlHit(
  sql: postgres.Sql,
  jobUrl: string | null,
  companyName: string | null,
): Promise<{ job_posting_id: string; lead_id: string | null } | null> {
  if (!jobUrl) return null;
  const normUrl = normalizeJobUrl(jobUrl);
  const fullKey = (companyName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const strippedKey = normalizeCompanyKey(companyName);
  if (!normUrl) return null;
  const rows = await sql.unsafe(
    `SELECT jp.id AS job_posting_id, l.id AS lead_id
       FROM job_postings jp
       JOIN companies c ON c.id = jp.company_id
       LEFT JOIN leads l ON l.job_posting_id = jp.id
      WHERE ${NORMALIZED_JOB_URL_SQL} = $1
        AND ($2::text IS NULL OR regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g') IN ($2, $3))
      ORDER BY jp.first_seen_at DESC LIMIT 1`,
    [normUrl, companyName ? fullKey : null, companyName ? strippedKey : null] as any,
  );
  return (rows as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0] ?? null;
}

/**
 * Near-duplicate probe, executed by Postgres rather than in JS.
 * The first port of the scraper's rule loaded up to 2000 recent leads and ran a full
 * Levenshtein matrix against each one, per imported row. On a real sheet that is millions
 * of character comparisons on the event loop: a 2600-row import measured 4+ minutes and
 * starved every other request behind it. Here the same intent becomes one parameterised
 * query — exact employer match plus trigram similarity on the title — so the cost per row
 * is flat and off the JS thread.
 */
async function findFuzzy(
  sql: postgres.Sql,
  company: string | null,
  title: string | null,
  url: string | null,
): Promise<string | null> {
  if (!company || !title) return null;
  const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normCompany || !normTitle) return null;
  const host = urlHostname(url ?? '');
  const hits = await sql.unsafe(
    `SELECT l.id
       FROM leads l
       JOIN companies c ON c.id = l.company_id
       JOIN job_postings jp ON jp.id = l.job_posting_id
      WHERE lower(regexp_replace(c.name, '[^a-zA-Z0-9]', '', 'g')) = $1
        AND ($2::text = '' OR split_part(coalesce(jp.job_url, ''), '/', 3) = $2)
        AND similarity(lower(regexp_replace(coalesce(jp.title, ''), '[^a-zA-Z0-9 ]', ' ', 'g')), $3) >= $4
      ORDER BY l.created_at DESC
      LIMIT 1`,
    [normCompany, host, normTitle, FUZZY_THRESHOLD] as any,
  );
  return (hits as unknown as Array<{ id: string }>)[0]?.id ?? null;
}

/**
 * Score a lead this import just created, without reading it back.
 *
 * Mirrors calculateLeadScore's inputs from data already in hand. Merged leads still go
 * through recomputeLeadScore because their pre-existing company/contact columns matter.
 */
async function scoreFreshLead(
  sql: postgres.Sql,
  input: UpsertInput,
  companyId: string | null,
  contactId: string | null,
): Promise<void> {
  const { rec, companyName, jobTitle, jobUrl } = input;
  if (!companyName || !jobTitle) return;
  try {
    const weights = await loadScoringWeightsOnce(sql);
    // Company official contacts affect the score; read them only when a company exists.
    let companyContact: { default_email: string | null; default_phone: string | null } = { default_email: null, default_phone: null };
    if (companyId) {
      const co = await sql.unsafe(`SELECT default_email, default_phone FROM companies WHERE id = $1`, [companyId] as any);
      companyContact = (co as unknown as Array<typeof companyContact>)[0] ?? companyContact;
    }
    let hasEmail = Boolean(input.hrEmail);
    let hasMobile = Boolean(input.hrMobile);
    let hasLinkedin = Boolean(input.hrLinkedin);
    let hrName = Boolean(input.hrName);
    if (contactId) {
      const hc = await sql.unsafe(
        `SELECT nullif(full_name,'') n, nullif(personal_email,'') e, nullif(personal_mobile,'') m, nullif(linkedin_url,'') l
           FROM hr_contacts WHERE id = $1`, [contactId] as any);
      const row = (hc as unknown as Array<{ n: string | null; e: string | null; m: string | null; l: string | null }>)[0];
      if (row) { hrName = Boolean(row.n); hasEmail = Boolean(row.e); hasMobile = Boolean(row.m); hasLinkedin = Boolean(row.l); }
    }
    const desc = text(rec.job_description) ?? text(rec.about_job);
    const result = calculateLeadScore({
      hr_name: hrName ? (input.hrName ?? 'x') : null,
      hr_personal_email: hasEmail ? input.hrEmail : null,
      hr_personal_mobile: hasMobile ? input.hrMobile : null,
      hr_linkedin_url: hasLinkedin ? (input.hrLinkedin ?? null) : null,
      company_default_email: companyContact.default_email,
      company_default_phone: companyContact.default_phone,
      salary_range: blankToNull(rec.salary_range),
      job_description: desc,
      job_url: jobUrl,
      email_status: null,
      whatsapp_status: null,
    }, weights);
    await sql.unsafe(`UPDATE leads SET lead_score = $1, updated_at = NOW() WHERE id = $2`, [result.score, input.newLeadId] as any);
  } catch {
    // Scoring must never fail an import; the worker will recompute on enrichment anyway.
    await recomputeLeadScore(sql, input.newLeadId!).catch(() => undefined);
  }
}

let cachedWeights: Record<string, number> | null = null;
let weightsLoadedFor: string | null = null;
async function loadScoringWeightsOnce(sql: postgres.Sql): Promise<Record<string, number> | undefined> {
  // Load operator weights once per process rather than per row (they change rarely and
  // only via the admin Settings page).
  if (cachedWeights && weightsLoadedFor === 'v1') return cachedWeights as unknown as Record<string, number>;
  const w = await loadScoringWeights(sql);
  cachedWeights = w as unknown as Record<string, number>;
  weightsLoadedFor = 'v1';
  return w as unknown as Record<string, number>;
}

interface UpsertInput {
  rec: Record<string, string>;
  companyName: string | null; jobTitle: string | null; jobUrl: string | null;
  hrName: string | null; hrEmail: string; hrMobile: string | null; hrLinkedin: string | null;
  fp: string; hasIdentity: boolean;
  /** Exact lead UUID from the Lead ID column (our own export); null when absent/invalid. */
  leadId: string | null;
  user: { id: string; role: string; email?: string };
  sourceLabel: string;
  /** True when this row's email/phone is on the suppression list. */
  suppressedEmail?: boolean;
  cache: ImportCache;
  /** Filled in by upsertOne so scoreFreshLead can write without another lookup. */
  newLeadId?: string;
}

/** Outcome of one row, including the ids it touched so a later row of the same file can
 * fold into them without another round trip. */
export interface UpsertOutcome {
  kind: 'created' | 'merged' | 'merged_fuzzy';
  job_posting_id: string;
  lead_id: string | null;
}

async function upsertOne(sql: postgres.Sql, input: UpsertInput): Promise<UpsertOutcome> {
  const { rec, companyName, jobTitle, jobUrl, hrName, hrEmail, hrMobile, hrLinkedin, fp, hasIdentity, user, sourceLabel } = input;
  const domain = employerDomainOf(companyName ?? '', jobUrl, blankToNull(rec.company_domain)) || null;

  // ---- 0. Lead ID (re-imported export names the exact row) --------------------
  if (input.leadId) {
    const byId = await findByLeadId(sql, input.leadId);
    if (byId) {
      await mergeIntoPosting(sql, byId, input, domain);
      return { kind: 'merged', job_posting_id: byId.job_posting_id, lead_id: byId.lead_id };
    }
  }

  // ---- 1. exact fingerprint -------------------------------------------------
  const cachedFp = input.cache.byFingerprint.get(fp);
  if (cachedFp) {
    await mergeIntoPosting(sql, cachedFp, input, employerDomainOf(companyName ?? '', jobUrl, blankToNull(rec.company_domain)) || null);
    return { kind: 'merged', job_posting_id: cachedFp.job_posting_id, lead_id: cachedFp.lead_id };
  }
  const byFp = await fingerprintHit(sql, fp);

  // ---- 2. company+url identity (rows with no title to fingerprint on) --------
  // Canonicalised both sides: trailing slashes, ?utm tags and "Pvt Ltd" variants merge.
  let byUrl: { job_posting_id: string; lead_id: string | null } | undefined;
  if (!byFp && jobUrl) {
    byUrl = input.cache.byUrl.get(urlKey(jobUrl, companyName)) ?? await urlHit(sql, jobUrl, companyName) ?? undefined;
  }

  const prematch = byFp ?? byUrl;
  if (prematch) {
    await mergeIntoPosting(sql, prematch, input, domain);
    return { kind: 'merged', job_posting_id: prematch.job_posting_id, lead_id: prematch.lead_id };
  }

  // ---- 3. fuzzy --------------------------------------------------------------
  const fuzzyLeadId = hasIdentity ? await findFuzzy(sql, companyName, jobTitle, jobUrl) : null;

  // ---- 4. insert -------------------------------------------------------------
  const companyId = await upsertCompany(sql, companyName, domain, rec, input.cache);
  const contactId = await upsertContact(sql, companyId, { hrName, hrEmail, hrMobile, hrLinkedin, rec, cache: input.cache });
  const facets = postingValues(input, domain);

  const postingWrite = await sql.unsafe(
    `INSERT INTO job_postings
       (company_id, hr_contact_id, title, description, experience_level, salary_range,
        job_url, source_site, fingerprint, raw_payload, location, city, state, country,
        location_type, employment_type, is_work_from_home, apply_url, posted_at, about_job,
        department, openings_count, salary_min, salary_max, salary_currency, salary_period,
        freshness_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
       CASE WHEN $19::timestamptz > NOW() - INTERVAL '24 hours' THEN 'fresh'
            WHEN $19::timestamptz > NOW() - INTERVAL '7 days' THEN 'recent'
            WHEN $19::timestamptz IS NULL THEN 'unknown'
            ELSE 'older' END)
     ON CONFLICT (fingerprint) DO NOTHING
     RETURNING id`,
    [
      companyId, contactId, short(jobTitle) ?? '(untitled import)',
      text(rec.job_description) ?? text(rec.about_job),
      short(rec.experience_level), short(rec.salary_range),
      jobUrl ?? `import://${fp.slice(0, 24)}`, short(rec.source_site) ?? sourceLabel,
      fp, JSON.stringify({ import_source: sourceLabel, ...rec }),
      ...facets,
    ] as any,
  );
  let postingId = (postingWrite as unknown as Array<{ id: string }>)[0]?.id;
  let racedIntoExistingLead: string | null = null;

  if (!postingId) {
    // Another writer (scraper or a parallel import row) took the fingerprint between
    // our check and our insert: treat it as the merge case rather than erroring.
    const loser = await sql.unsafe(
      `SELECT jp.id AS job_posting_id, l.id AS lead_id FROM job_postings jp
         LEFT JOIN leads l ON l.job_posting_id = jp.id WHERE jp.fingerprint = $1 LIMIT 1`,
      [fp] as any,
    );
    const row = (loser as unknown as Array<{ job_posting_id: string; lead_id: string | null }>)[0];
    if (!row) throw new Error('duplicate key');  // surfaced via classifyImportError
    await mergeIntoPosting(sql, row, input, domain);
    return { kind: 'merged', job_posting_id: row.job_posting_id, lead_id: row.lead_id };
  }

  const leadWrite = await sql.unsafe(
    `INSERT INTO leads (job_posting_id, company_id, hr_contact_id, pipeline_stage, data_quality,
                        assigned_to, possible_duplicate_of, do_not_contact, legal_basis, processing_purpose, provenance)
     VALUES ($1,$2,$3,'discovered',$4,$5,$6,$7,'legitimate_interest_b2b','b2b_recruitment_outreach',
             jsonb_build_object('source_site', $8::text, 'imported_by', $9::text, 'imported_at', now()::text))
     ON CONFLICT (job_posting_id) DO NOTHING
     RETURNING id`,
    [
      postingId, companyId, contactId,
      hrName && (hrEmail || hrMobile || hrLinkedin) ? 'complete' : 'incomplete',
      // sales_rep RBAC filters on assigned_to, so an unassigned import would be
      // invisible to the person who just ran it. Admin imports stay unassigned.
      user.role === 'sales_rep' ? user.id : null,
      fuzzyLeadId,
      // Opted-out contact: stored for completeness, never worked. The send guard reads
      // this flag, so the lead cannot be mailed even though it is now in the queue.
      input.suppressedEmail ? true : false,
      blankToNull(rec.source_site) ?? sourceLabel, user.email ?? user.id,
    ] as any,
  );
  const newLeadId = (leadWrite as unknown as Array<{ id: string }>)[0]?.id;
  if (!newLeadId) {
    const existing = await sql.unsafe(`SELECT id FROM leads WHERE job_posting_id = $1 LIMIT 1`, [postingId] as any);
    racedIntoExistingLead = (existing as unknown as Array<{ id: string }>)[0]?.id ?? null;
    if (!racedIntoExistingLead) throw new Error('lead conflict with no readable lead');
  }
  const leadId = newLeadId ?? racedIntoExistingLead!;
  input.newLeadId = leadId;
  

  // A brand-new lead's score depends only on values we just wrote, so compute it here
  // rather than reading the row back through recomputeLeadScore (2 extra round trips per
  // row, which dominated import time). Same weights, same formula; if operator-tuned
  // weights exist they are loaded once per import below.
  await scoreFreshLead(sql, input, companyId, contactId);

  return { kind: fuzzyLeadId ? 'merged_fuzzy' : 'created', job_posting_id: postingId, lead_id: leadId };
}

/** Fill-only-blank update of an existing posting/lead/contact pair. */
async function mergeIntoPosting(
  sql: postgres.Sql,
  target: { job_posting_id: string; lead_id: string | null },
  input: UpsertInput,
  domain: string | null,
): Promise<void> {
  const { companyName, hrName, hrEmail, hrMobile, hrLinkedin, rec } = input;
  const [loc, city, state, country, locationType, employmentType, wfh, applyUrl, postedAt, aboutJob, dept, openings, smin, smax, cur, per] = postingValues({ ...input, rec }, domain);
  const desc = text(rec.job_description) ?? text(rec.about_job);

  await sql.unsafe(
    `UPDATE job_postings SET
       last_seen_at = NOW(),
       description      = COALESCE(description, $1),
       experience_level = COALESCE(experience_level, $2),
       salary_range     = COALESCE(salary_range, $3),
       location         = COALESCE(location, $4),
       city             = COALESCE(city, $5),
       state            = COALESCE(state, $6),
       country          = COALESCE(country, $7),
       location_type    = COALESCE(location_type, $8),
       employment_type  = COALESCE(employment_type, $9),
       is_work_from_home= COALESCE(is_work_from_home, $10),
       apply_url        = COALESCE(apply_url, $11),
       posted_at        = COALESCE(posted_at, $12),
       freshness_category = CASE WHEN COALESCE(posted_at, $12)::timestamptz > NOW() - INTERVAL '24 hours' THEN 'fresh'
            WHEN COALESCE(posted_at, $12)::timestamptz > NOW() - INTERVAL '7 days' THEN 'recent'
            WHEN COALESCE(posted_at, $12)::timestamptz IS NULL THEN 'unknown'
            ELSE 'older' END,
       about_job        = COALESCE(about_job, $13),
       department       = COALESCE(department, $14),
       openings_count   = COALESCE(openings_count, $15),
       salary_min       = COALESCE(salary_min, $16),
       salary_max       = COALESCE(salary_max, $17),
       salary_currency  = COALESCE(salary_currency, $18),
       salary_period    = COALESCE(salary_period, $19),
       source_site      = CASE WHEN COALESCE(source_site,'') = '' THEN $20 ELSE source_site END
     WHERE id = $21`,
    [desc, short(rec.experience_level), short(rec.salary_range), loc, city, state, country,
     locationType, employmentType, wfh, applyUrl, postedAt, aboutJob, dept, openings, smin, smax, cur, per,
     blankToNull(rec.source_site), target.job_posting_id] as any,
  );

  if (companyName) {
    await sql.unsafe(
      `UPDATE companies SET
         domain        = COALESCE(domain, $1),
         industry      = COALESCE(industry, $2),
         size_estimate = COALESCE(size_estimate, $3),
         website_url   = COALESCE(website_url, $4),
         default_email = COALESCE(default_email, $5),
         default_phone = COALESCE(default_phone, $6),
         about         = COALESCE(about, $7),
         updated_at    = NOW()
       WHERE id = (SELECT company_id FROM job_postings WHERE id = $8)`,
      [domain, short(rec.industry), short(rec.size_estimate), short(rec.website_url),
       short(rec.default_email), short(rec.default_phone), text(rec.about_company),
       target.job_posting_id] as any,
    );
  }

  if (hrName || hrEmail || hrMobile || hrLinkedin) {
    const contactId = await sql.unsafe(
      `SELECT hr_contact_id FROM job_postings WHERE id = $1`, [target.job_posting_id] as any,
    );
    const existingContact = (contactId as unknown as Array<{ hr_contact_id: string | null }>)[0]?.hr_contact_id;
    if (existingContact) {
      await sql.unsafe(
        `UPDATE hr_contacts SET
           full_name      = COALESCE(full_name, $1),
           personal_email = COALESCE(personal_email, $2),
           personal_mobile= COALESCE(personal_mobile, $3),
           linkedin_url   = COALESCE(linkedin_url, $4),
           confidence_score = GREATEST(COALESCE(confidence_score,0), $5),
           updated_at     = NOW()
         WHERE id = $6`,
        [short(hrName), hrEmail || null, short(hrMobile), short(hrLinkedin), confidenceOf(rec), existingContact] as any,
      );
    } else {
      const created = await sql.unsafe(
        `INSERT INTO hr_contacts (full_name, linkedin_url, personal_email, personal_mobile,
                                  current_company_id, contact_source, confidence_score, extraction_provenance)
         SELECT $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), jp.company_id, 'imported', $5,
                jsonb_build_object('imported_at', now()::text)
           FROM job_postings jp WHERE jp.id = $6
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [short(hrName), short(hrLinkedin), hrEmail, short(hrMobile), confidenceOf(rec), target.job_posting_id] as any,
      );
      const newContact = (created as unknown as Array<{ id: string }>)[0]?.id;
      if (newContact) {
        await sql.unsafe(`UPDATE job_postings SET hr_contact_id = $1 WHERE id = $2 AND hr_contact_id IS NULL`, [newContact, target.job_posting_id] as any);
        await sql.unsafe(`UPDATE leads SET hr_contact_id = $1 WHERE job_posting_id = $2 AND hr_contact_id IS NULL`, [newContact, target.job_posting_id] as any);
      }
    }
  }

  if (!target.lead_id) {
    // Posting existed but nobody had turned it into a lead yet: attach one so the
    // imported contact/stage actually shows up in the queue.
    const leadRow = await sql.unsafe(
      `INSERT INTO leads (job_posting_id, company_id, hr_contact_id, pipeline_stage, data_quality,
                          assigned_to, do_not_contact, provenance)
       SELECT jp.id, jp.company_id, jp.hr_contact_id, 'discovered', $2, $3, $4,
              jsonb_build_object('source_site', 'import', 'merged_existing_posting', true, 'imported_at', now()::text)
         FROM job_postings jp WHERE jp.id = $1
       ON CONFLICT (job_posting_id) DO NOTHING
       RETURNING id`,
      [target.job_posting_id,
       hrName && (hrEmail || hrMobile || hrLinkedin) ? 'complete' : 'incomplete',
       input.user.role === 'sales_rep' ? input.user.id : null,
       input.suppressedEmail ? true : false] as any,
    );
    const newId = (leadRow as unknown as Array<{ id: string }>)[0]?.id;
    if (newId) await recomputeLeadScore(sql, newId).catch(() => undefined);
    return;
  }

  await sql.unsafe(
    `UPDATE leads SET
       -- An opt-out can only be added by an import, never removed: OR keeps a lead that
       -- is already suppressed suppressed.
       do_not_contact = COALESCE(do_not_contact, false) OR $3,
       hr_contact_id = COALESCE(hr_contact_id, (SELECT hr_contact_id FROM job_postings WHERE id = $2)),
       data_quality  = CASE WHEN data_quality = 'complete' THEN data_quality
                            WHEN COALESCE((SELECT NULLIF(hc.full_name,'') FROM hr_contacts hc
                                            JOIN leads ll ON ll.hr_contact_id = hc.id WHERE ll.id = $1), '') <> ''
                            THEN 'complete' ELSE data_quality END,
       provenance    = COALESCE(provenance, '{}'::jsonb) || jsonb_build_object('csv_import_merged_at', now()::text),
       updated_at    = NOW()
     WHERE id = $1`,
    [target.lead_id, target.job_posting_id, input.suppressedEmail ? true : false] as any,
  );
  await recomputeLeadScore(sql, target.lead_id).catch(() => undefined);
}

async function upsertCompany(
  sql: postgres.Sql,
  name: string | null,
  domain: string | null,
  rec: Record<string, string>,
  cache?: ImportCache,
): Promise<string | null> {
  if (!name && !domain) return null;

  // Prefetched by lower(name)/domain/normalized key for the whole file; a miss falls
  // through to the query. All key forms are checked, so "Acme" vs "Acme Pvt. Ltd."
  // meet instead of becoming two companies (and then two leads).
  const fullKey = name ? name.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
  const strippedKey = name ? normalizeCompanyKey(name) : null;
  const cached = name
    ? cache?.companies.get(name.toLowerCase())
      ?? (fullKey ? cache?.companies.get(fullKey) : undefined)
      ?? (strippedKey ? cache?.companies.get(strippedKey) : undefined)
    : (domain ? cache?.companies.get(`domain:${domain.toLowerCase()}`) : undefined);
  if (cached) {
    await fillCompany(sql, cached, domain, rec);
    return cached;
  }

  const found = await sql.unsafe(
    `SELECT id FROM companies
      WHERE ($1::text IS NOT NULL AND (lower(name) = lower($1) OR ${NORMALIZED_COMPANY_SQL} = $3 OR ${NORMALIZED_COMPANY_SQL} = $4))
         OR ($2::text IS NOT NULL AND lower(domain) = lower($2))
      ORDER BY (lower(name) = lower($1::text)) DESC NULLS LAST LIMIT 1`,
    [name, domain, fullKey, strippedKey] as any,
  );
  const hit = (found as unknown as Array<{ id: string }>)[0]?.id;
  if (hit) {
    if (name) cache?.companies.set(name.toLowerCase(), hit);
    if (domain) cache?.companies.set(`domain:${domain.toLowerCase()}`, hit);
    await fillCompany(sql, hit, domain, rec);
    return hit;
  }
  if (!name) return null; // companies.name is NOT NULL

  const inserted = await sql.unsafe(
    `INSERT INTO companies (name, domain, industry, size_estimate, website_url, default_email, default_phone, about)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (lower(name)) DO NOTHING RETURNING id`,
    [clamp(name, MAX_SHORT), clamp(domain, MAX_SHORT), short(rec.industry), short(rec.size_estimate), short(rec.website_url),
     short(rec.default_email), short(rec.default_phone), text(rec.about_company)] as any,
  );
  const newId = (inserted as unknown as Array<{ id: string }>)[0]?.id;
  if (newId) {
    cache?.companies.set(name.toLowerCase(), newId);
    return newId;
  }
  // Lost an ON CONFLICT race (another row of this file, or the scraper): reuse that row.
  const retry = await sql.unsafe(`SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [name] as any);
  const retriedId = (retry as unknown as Array<{ id: string }>)[0]?.id ?? null;
  if (retriedId) cache?.companies.set(name.toLowerCase(), retriedId);
  return retriedId;
}

/** Fill-only-blank company refresh: an import adds what is missing, never overwrites. */
async function fillCompany(
  sql: postgres.Sql,
  id: string,
  domain: string | null,
  rec: Record<string, string>,
): Promise<void> {
  await sql.unsafe(
    `UPDATE companies SET
       domain = COALESCE(domain, $2), industry = COALESCE(industry, $3),
       size_estimate = COALESCE(size_estimate, $4), website_url = COALESCE(website_url, $5),
       default_email = COALESCE(default_email, $6), default_phone = COALESCE(default_phone, $7),
       about = COALESCE(about, $8), updated_at = NOW()
     WHERE id = $1`,
    [id, clamp(domain, MAX_SHORT), short(rec.industry), short(rec.size_estimate),
     short(rec.website_url), short(rec.default_email),
     short(rec.default_phone), text(rec.about_company)] as any,
  );
}

function confidenceOf(rec: Record<string, string>): number {
  const declared = num(rec.confidence_score ?? rec.hr_confidence);
  if (declared != null) return Math.max(0, Math.min(100, Math.round(declared)));
  // A hand-curated list with a named person, a direct email and a LinkedIn profile
  // is worth more than a bare company row.
  let score = 20;
  if (blankToNull(rec.hr_name)) score += 20;
  if (blankToNull(rec.hr_email)) score += 30;
  if (blankToNull(rec.hr_mobile)) score += 15;
  if (short(rec.hr_linkedin_url)) score += 15;
  return Math.min(score, 100);
}

async function upsertContact(
  sql: postgres.Sql,
  companyId: string | null,
  c: { hrName: string | null; hrEmail: string; hrMobile: string | null; hrLinkedin: string | null; rec: Record<string, string>; cache?: ImportCache },
): Promise<string | null> {
  const { cache } = c;
  const { hrName, hrEmail, hrMobile, hrLinkedin, rec } = c;
  if (!hrName && !hrEmail && !hrMobile && !hrLinkedin) return null;

  // Reuse the same person at the same employer, keyed on a value we actually have.
  // (Matching on '' = '' once attached one blank contact to 137 unrelated companies.)
  const cachedContact = cache?.contacts.get(contactKey(companyId, hrEmail, hrLinkedin, hrMobile));
  if (cachedContact) {
    await fillContact(sql, cachedContact, hrName, hrEmail, hrMobile, hrLinkedin, companyId, rec);
    return cachedContact;
  }
  const found = await sql.unsafe(
    `SELECT id FROM hr_contacts
      WHERE ($1::uuid IS NULL OR current_company_id = $1)
        AND ( ($2::text IS NOT NULL AND lower(personal_email) = $2)
           OR ($3::text IS NOT NULL AND lower(regexp_replace(regexp_replace(linkedin_url, '[?#].*$', ''), '/+$', '', 'g')) = $3)
           OR ($4::text IS NOT NULL AND personal_mobile = $4) )
      LIMIT 1`,
    [companyId, hrEmail.toLowerCase() || null, normalizeLinkedin(hrLinkedin) || null, hrMobile] as any,
  );
  const hit = (found as unknown as Array<{ id: string }>)[0]?.id;
  if (hit) {
    cache?.contacts.set(contactKey(companyId, hrEmail, hrLinkedin, hrMobile), hit);
    await fillContact(sql, hit, hrName, hrEmail, hrMobile, hrLinkedin, companyId, rec);
    return hit;
  }
  const inserted = await sql.unsafe(
    `INSERT INTO hr_contacts (full_name, linkedin_url, personal_email, personal_mobile,
                              current_company_id, confidence_score, contact_source, contact_method, extraction_provenance)
     VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),$5,$6,'imported',$7,
             jsonb_build_object('imported_at', now()::text))
     RETURNING id`,
    [short(hrName), short(hrLinkedin), hrEmail, short(hrMobile), companyId, confidenceOf(rec), short(rec.source_site) ?? 'csv_import'] as any,
  );
  const createdId = (inserted as unknown as Array<{ id: string }>)[0]?.id ?? null;
  if (createdId) cache?.contacts.set(contactKey(companyId, hrEmail, hrLinkedin, hrMobile), createdId);
  return createdId;
}

/** Fill-only-blank contact refresh, shared by the cached and queried lookup paths. */
async function fillContact(
  sql: postgres.Sql,
  id: string,
  hrName: string | null,
  hrEmail: string,
  hrMobile: string | null,
  hrLinkedin: string | null,
  companyId: string | null,
  rec: Record<string, string>,
): Promise<void> {
  await sql.unsafe(
    `UPDATE hr_contacts SET full_name = COALESCE(full_name, $1),
       personal_email = COALESCE(personal_email, $2), personal_mobile = COALESCE(personal_mobile, $3),
       linkedin_url = COALESCE(linkedin_url, $4), current_company_id = COALESCE(current_company_id, $5),
       confidence_score = GREATEST(COALESCE(confidence_score,0), $6), updated_at = NOW()
     WHERE id = $7`,
    [short(hrName), hrEmail || null, short(hrMobile), short(hrLinkedin), companyId, confidenceOf(rec), id] as any,
  );
}

/**
 * A header may be recognised as one field while the value semantically belongs to another
 * ("Work Mode" -> location_type already, but some sheets say "Remote / Hybrid" under a
 * generic 'remote' column). Copy such values onto the canonical key the writer reads.
 */
function withAliases(rec: Record<string, string>): Record<string, string> {
  const out = { ...rec };
  const setIfMissing = (to: string, from: string) => { if (!out[to] && out[from]) out[to] = out[from]; };
  setIfMissing('location_type', 'work_mode');
  setIfMissing('employment_type', 'job_type');
  setIfMissing('salary_min', 'ctc_min');
  setIfMissing('salary_max', 'ctc_max');
  return out;
}

/** Positional values for the 16 job_postings facet columns, shared by insert and merge. */
function postingValues(input: UpsertInput, domain: string | null): unknown[] {
  const { jobUrl, rec } = input;
  const loc = blankToNull(rec.location);
  const parts = (loc ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const city = blankToNull(rec.city) ?? (parts.length > 1 ? parts[0] : null);
  const state = blankToNull(rec.state) ?? (parts.length > 2 ? parts[parts.length - 2] : null);
  const country = blankToNull(rec.country) ?? (parts.length ? parts[parts.length - 1] : null);
  const smin = num(rec.salary_min);
  const smax = num(rec.salary_max);
  const wfh = bool(rec.is_work_from_home);
  const locationType = locationTypeOf(rec);
  return [
    loc, city, state, country,
    locationType, employmentTypeOf(rec.employment_type),
    wfh ?? (locationType === 'remote' ? true : null),
    short(rec.apply_url) ?? (domain && jobUrl ? jobUrl : null),
    guessPostedAt(rec.posted_at), text(rec.about_job),
    short(rec.department), num(rec.openings_count),
    smin, smax != null && smin != null && smax < smin ? smin : smax,
    currencyOf(rec), periodOf(rec),
  ];
}

/** Convenience wrapper used by the route: parse text then import. */
export async function importCsvText(
  sql: postgres.Sql,
  text: string,
  user: { id: string; role: string; email?: string },
  opts: { dryRun?: boolean } = {},
): Promise<ImportResult & { columns_mapped: Record<string, string>; columns_ignored: string[] }> {
  if (text.length > MAX_CSV_CHARS) {
    throw Object.assign(
      new Error(`File is too large (${(text.length / 1e6).toFixed(1)} MB). Split it into files under ${MAX_CSV_CHARS / 1e6} MB.`),
      { statusCode: 413 },
    );
  }
  const table = parseDelimited(text);
  if (table.length < 2) {
    throw Object.assign(new Error('File needs a header row and at least one data row'), { statusCode: 400 });
  }
  const { records, mapped, unmapped } = normaliseLeadRecords(table);
  const res = await importLeadRecords(sql, records, user, opts);
  return { ...res, columns_mapped: mapped, columns_ignored: unmapped };
}
