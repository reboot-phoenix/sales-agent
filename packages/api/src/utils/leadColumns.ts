import crypto from 'crypto';

/**
 * Single source of truth for lead data shape.
 *
 * The list query, the Excel/CSV export and the CSV import all read this file. They
 * used to be three hand-maintained copies of the same column list, which is how the
 * export ended up blanking every field the table SELECT never got round to adding
 * (job description, HR contact provenance, company profile, legal basis): a column
 * only appeared in the workbook if someone remembered to add it in two places.
 *
 * Add a field here once -> it is selected, exported and importable.
 */

/** The SELECT list for any query returning lead rows (aliases must stay identical). */
export const LEAD_SELECT_SQL = `
        l.id, l.lead_score, l.score_band, l.pipeline_stage, l.data_quality,
        l.email_status, l.whatsapp_status, l.do_not_contact, l.assigned_to,
        l.claimed_by, l.claimed_at,
        l.legal_basis, l.processing_purpose, l.provenance, l.possible_duplicate_of,
        l.created_at, l.updated_at,
        -- Product scale 1–10 derived from canonical 0–100 (no rescale migration;
        -- engine, weights and hot>=70/warm>=40 bands stay untouched).
        GREATEST(1, LEAST(10, ROUND(l.lead_score / 10.0))) AS score_10,
        -- Stored freshness label (writers set it at insert/merge, the daily
        -- scheduler reclassifies aging rows; migration 012). Falls back to a
        -- live computation for rows predating the backfill.
        COALESCE(jp.freshness_category,
          CASE WHEN COALESCE(jp.posted_at, l.created_at) IS NULL THEN 'unknown'
               WHEN COALESCE(jp.posted_at, l.created_at) > NOW() - INTERVAL '24 hours' THEN 'fresh'
               WHEN COALESCE(jp.posted_at, l.created_at) > NOW() - INTERVAL '7 days' THEN 'recent'
               ELSE 'older' END) AS freshness_category,
        jp.source_site, jp.title AS job_title,
        -- The table renders location / salary / experience per row; these were
        -- never selected, so every cell fell back to a placeholder.
        jp.job_url, jp.apply_url, jp.salary_range, jp.experience_level,
        jp.description AS job_description, jp.about_job,
        jp.location, jp.city, jp.state, jp.country, jp.location_type,
        jp.employment_type, jp.is_work_from_home, jp.posted_at,
        jp.department, jp.openings_count,
        jp.salary_min, jp.salary_max, jp.salary_currency, jp.salary_period,
        c.name as company_name, c.domain as company_domain,
        c.industry, c.size_estimate, c.about as about_company,
        c.website_url, c.default_email, c.default_phone,
        c.employee_count, c.revenue, c.founded_year,
        c.city as company_city, c.country as company_country,
        hc.full_name as hr_name, hc.linkedin_url as hr_linkedin_url,
        hc.personal_email as hr_email, hc.personal_mobile as hr_mobile,
        hc.job_title as hr_title, hc.department as hr_department,
        hc.seniority as hr_seniority, hc.location as hr_location,
        hc.emails as hr_emails, hc.phones as hr_phones,
        hc.email_verified as hr_email_verified,
        hc.confidence_score as hr_confidence, hc.contact_source,
        hc.contact_method, hc.contact_url,
        -- assigned_to alone is a bare UUID; without the owner's email the column is
        -- unreadable in the UI and meaningless in an exported spreadsheet.
        au.email as assigned_to_email,
        cu.email as claimed_by_email`.trim();

export type ExportType = 'Number' | 'DateTime' | 'Url' | 'Bool';

export interface ExportColumn {
  header: string;
  /** Canonical key this column maps to/from on a lead row. */
  field: string;
  group: string;
  get: (r: any) => unknown;
  type?: ExportType;
  width: number;
}

export const LOCATION_GROUP = 'Location & terms';

/** Columns exported for every lead, grouped left to right the way a rep reads a row. */
export const LEAD_EXPORT_COLUMNS: ExportColumn[] = [
  // Identity
  { header: 'Score', field: 'lead_score', group: 'Identity', get: (r) => r.lead_score, type: 'Number', width: 8 },
  { header: 'Score (1-10)', field: 'score_10', group: 'Identity', get: (r) => r.score_10 ?? '', type: 'Number', width: 12 },
  { header: 'Freshness', field: 'freshness_category', group: 'Identity', get: (r) => r.freshness_category || '', width: 10 },
  { header: 'Band', field: 'score_band', group: 'Identity', get: (r) => r.score_band, width: 10 },
  { header: 'Lead ID', field: 'id', group: 'Identity', get: (r) => r.id, width: 36 },
  { header: 'Pipeline Stage', field: 'pipeline_stage', group: 'Identity', get: (r) => r.pipeline_stage, width: 18 },
  { header: 'Data Quality', field: 'data_quality', group: 'Identity', get: (r) => r.data_quality, width: 14 },
  { header: 'Assigned To', field: 'assigned_to_email', group: 'Identity', get: (r) => r.assigned_to_email || r.assigned_to || '', width: 26 },
  { header: 'Do Not Contact', field: 'do_not_contact', group: 'Identity', get: (r) => (r.do_not_contact ? 'YES' : 'no'), width: 14 },
  { header: 'Possible Duplicate Of', field: 'possible_duplicate_of', group: 'Identity', get: (r) => r.possible_duplicate_of || '', width: 36 },
  { header: 'Legal Basis', field: 'legal_basis', group: 'Identity', get: (r) => r.legal_basis, width: 24 },
  { header: 'Processing Purpose', field: 'processing_purpose', group: 'Identity', get: (r) => r.processing_purpose, width: 26 },

  // Job posting
  { header: 'Job Title', field: 'job_title', group: 'Job posting', get: (r) => r.job_title, width: 40 },
  { header: 'Source', field: 'source_site', group: 'Job posting', get: (r) => r.source_site, width: 18 },
  { header: 'Department', field: 'department', group: 'Job posting', get: (r) => r.department, width: 18 },
  { header: 'Openings', field: 'openings_count', group: 'Job posting', get: (r) => r.openings_count, type: 'Number', width: 10 },
  { header: 'Experience', field: 'experience_level', group: 'Job posting', get: (r) => r.experience_level, width: 16 },
  { header: 'Job URL', field: 'job_url', group: 'Job posting', get: (r) => r.job_url, type: 'Url', width: 40 },
  { header: 'Apply URL', field: 'apply_url', group: 'Job posting', get: (r) => r.apply_url, type: 'Url', width: 40 },
  { header: 'Job Description', field: 'job_description', group: 'Job posting', get: (r) => r.job_description, width: 60 },
  { header: 'About Job', field: 'about_job', group: 'Job posting', get: (r) => r.about_job, width: 50 },

  // Location & terms
  { header: 'Location', field: 'location', group: LOCATION_GROUP, get: (r) => [r.city, r.state, r.country].filter(Boolean).join(', ') || r.location || '', width: 26 },
  { header: 'City', field: 'city', group: LOCATION_GROUP, get: (r) => r.city, width: 16 },
  { header: 'State', field: 'state', group: LOCATION_GROUP, get: (r) => r.state, width: 14 },
  { header: 'Country', field: 'country', group: LOCATION_GROUP, get: (r) => r.country, width: 12 },
  { header: 'Location Type', field: 'location_type', group: LOCATION_GROUP, get: (r) => r.location_type || (r.is_work_from_home ? 'remote' : ''), width: 14 },
  { header: 'Employment Type', field: 'employment_type', group: LOCATION_GROUP, get: (r) => r.employment_type, width: 16 },

  // Compensation
  { header: 'Salary Range', field: 'salary_range', group: 'Compensation', get: (r) => r.salary_range, width: 22 },
  { header: 'Salary Min', field: 'salary_min', group: 'Compensation', get: (r) => r.salary_min, type: 'Number', width: 12 },
  { header: 'Salary Max', field: 'salary_max', group: 'Compensation', get: (r) => r.salary_max, type: 'Number', width: 12 },
  { header: 'Currency', field: 'salary_currency', group: 'Compensation', get: (r) => r.salary_currency, width: 10 },
  { header: 'Salary Period', field: 'salary_period', group: 'Compensation', get: (r) => r.salary_period, width: 12 },

  // HR contact
  { header: 'HR Name', field: 'hr_name', group: 'HR contact', get: (r) => r.hr_name, width: 22 },
  { header: 'HR Title', field: 'hr_title', group: 'HR contact', get: (r) => r.hr_title, width: 24 },
  { header: 'HR Department', field: 'hr_department', group: 'HR contact', get: (r) => r.hr_department, width: 18 },
  { header: 'HR Seniority', field: 'hr_seniority', group: 'HR contact', get: (r) => r.hr_seniority, width: 14 },
  { header: 'HR Location', field: 'hr_location', group: 'HR contact', get: (r) => r.hr_location, width: 18 },
  { header: 'HR Extra Emails', field: 'hr_emails', group: 'HR contact', get: (r) => Array.isArray(r.hr_emails) ? r.hr_emails.join('; ') : r.hr_emails, width: 30 },
  { header: 'HR Extra Phones', field: 'hr_phones', group: 'HR contact', get: (r) => Array.isArray(r.hr_phones) ? r.hr_phones.join('; ') : r.hr_phones, width: 22 },
  { header: 'HR Email Verified', field: 'hr_email_verified', group: 'HR contact', get: (r) => (r.hr_email_verified ? 'YES' : 'no'), width: 16 },
  { header: 'HR Email', field: 'hr_email', group: 'HR contact', get: (r) => r.hr_email, width: 30 },
  { header: 'HR Mobile', field: 'hr_mobile', group: 'HR contact', get: (r) => r.hr_mobile, width: 16 },
  { header: 'HR LinkedIn', field: 'hr_linkedin_url', group: 'HR contact', get: (r) => r.hr_linkedin_url, type: 'Url', width: 34 },
  { header: 'Email Status', field: 'email_status', group: 'HR contact', get: (r) => r.email_status, width: 14 },
  { header: 'WhatsApp Status', field: 'whatsapp_status', group: 'HR contact', get: (r) => r.whatsapp_status, width: 16 },
  { header: 'HR Confidence', field: 'hr_confidence', group: 'HR contact', get: (r) => r.hr_confidence, type: 'Number', width: 13 },
  { header: 'Contact Source', field: 'contact_source', group: 'HR contact', get: (r) => r.contact_source, width: 18 },
  { header: 'Contact Method', field: 'contact_method', group: 'HR contact', get: (r) => r.contact_method, width: 20 },
  { header: 'Contact Found At', field: 'contact_url', group: 'HR contact', get: (r) => r.contact_url, type: 'Url', width: 34 },

  // Company
  { header: 'Company', field: 'company_name', group: 'Company', get: (r) => r.company_name, width: 28 },
  { header: 'Employees', field: 'employee_count', group: 'Company', get: (r) => r.employee_count, type: 'Number', width: 12 },
  { header: 'Revenue', field: 'revenue', group: 'Company', get: (r) => r.revenue, width: 18 },
  { header: 'Founded', field: 'founded_year', group: 'Company', get: (r) => r.founded_year, type: 'Number', width: 10 },
  { header: 'Domain', field: 'company_domain', group: 'Company', get: (r) => r.company_domain, width: 24 },
  { header: 'Industry', field: 'industry', group: 'Company', get: (r) => r.industry, width: 20 },
  { header: 'Company Size', field: 'size_estimate', group: 'Company', get: (r) => r.size_estimate, width: 16 },
  { header: 'Website', field: 'website_url', group: 'Company', get: (r) => r.website_url, type: 'Url', width: 28 },
  { header: 'Company Email', field: 'default_email', group: 'Company', get: (r) => r.default_email, width: 26 },
  { header: 'Company Phone', field: 'default_phone', group: 'Company', get: (r) => r.default_phone, width: 16 },
  { header: 'About Company', field: 'about_company', group: 'Company', get: (r) => r.about_company, width: 50 },

  // Timestamps
  { header: 'Posted', field: 'posted_at', group: 'Timestamps', get: (r) => r.posted_at, type: 'DateTime', width: 18 },
  { header: 'Discovered', field: 'created_at', group: 'Timestamps', get: (r) => r.created_at, type: 'DateTime', width: 18 },
  { header: 'Updated', field: 'updated_at', group: 'Timestamps', get: (r) => r.updated_at, type: 'DateTime', width: 18 },
];

/** Ordered group names, for headers and the Summary sheet. */
export const EXPORT_GROUPS: string[] = LEAD_EXPORT_COLUMNS.reduce((acc: string[], c) => {
  if (!acc.includes(c.group)) acc.push(c.group);
  return acc;
}, []);

// ---------------------------------------------------------------------------
// CSV (client-side "export what I can see", and the import parser)
// ---------------------------------------------------------------------------

/**
 * A value that opens with a formula sigil is *executed* by Excel/LibreOffice, so scraped or
 * imported text must never start one. '-' and '|' are as live as '=' (and '|' additionally
 * reaches DDE), hence the wider set. Exported here once and reused by every writer — the
 * server CSV previously had no guard at all because this lived in two places.
 */
export const FORMULA_OPENERS = /^[-+=@|\t\r\n]/;

/** Prefix with an apostrophe so spreadsheet software treats the value as literal text. */
export const guardFormula = (v: unknown): string => {
  const s = String(v ?? '');
  return FORMULA_OPENERS.test(s) ? `'${s}` : s;
};

export const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  // Flatten newlines: a quoted multi-line cell survives, but most tools (and our own
  // line-based preview) render it badly. One line per lead keeps the sheet usable.
  const s = String(v).replace(/\r?\n/g, ' ');
  return `"${guardFormula(s).replace(/"/g, '""')}"`;
};

/** CSV built from the same registry as the workbook, so the two can never disagree. */
export function leadsToCsv(rows: any[]): string {
  const cols = LEAD_EXPORT_COLUMNS;
  return '\ufeff' + [
    cols.map((c) => `"${c.header}"`).join(','),
    ...rows.map((r) => cols.map((c) => csvCell(c.get(r))).join(',')),
  ].join('\r\n');
}

/**
 * RFC4180-ish delimited parser: handles quoted fields, embedded quotes/newlines/commas,
 * CRLF, a stray BOM, and sniffs tab-separated files (Excel "text" paste output).
 */
export function parseDelimited(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  // Ragged rows are normal in hand-edited CRM exports; pad so index->header stays valid.
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill('')]));
}

/** Header aliases: our own export headers plus the spellings third-party CRMs use. */
const HEADER_ALIASES: Record<string, string[]> = {
  // The export writes 'Lead ID': recognising it back lets a re-imported export merge
  // onto the exact lead row instead of relying on fuzzy identity (strict no-dup).
  lead_id: ['lead_id', 'lead id', 'id'],
  company_name: ['company_name', 'company', 'organization', 'employer', 'account name', 'company name', 'client'],
  company_domain: ['company_domain', 'domain', 'company domain', 'website domain'],
  website_url: ['website_url', 'website', 'company website', 'url'],
  industry: ['industry', 'sector'],
  size_estimate: ['size_estimate', 'company size', 'employees', 'headcount'],
  default_email: ['default_email', 'company email', 'official email'],
  default_phone: ['default_phone', 'company phone', 'company mobile', 'office phone'],
  job_title: ['job_title', 'title', 'role', 'job title', 'position', 'designation', 'job role'],
  job_url: ['job_url', 'job url', 'job link', 'posting url', 'vacancy url', 'url of job'],
  apply_url: ['apply_url', 'apply url', 'apply link', 'application url'],
  source_site: ['source_site', 'source', 'source site', 'job board', 'portal', 'channel'],
  department: ['department', 'team', 'function'],
  openings_count: ['openings_count', 'openings', 'vacancies', 'positions available'],
  experience_level: ['experience_level', 'experience', 'experience required', 'years of experience', 'exp'],
  employment_type: ['employment_type', 'employment type', 'job type', 'type of employment'],
  location_type: ['location_type', 'work mode', 'workplace', 'remote', 'hybrid'],
  is_work_from_home: ['is_work_from_home', 'work from home', 'wfh'],
  location: ['location', 'job location', 'work location'],
  city: ['city', 'location city'],
  state: ['state', 'region', 'province'],
  country: ['country'],
  salary_range: ['salary_range', 'salary', 'ctc', 'compensation', 'salary range', 'pay'],
  salary_min: ['salary_min', 'min salary', 'salary min', 'minimum salary', 'ctc min'],
  salary_max: ['salary_max', 'max salary', 'salary max', 'maximum salary', 'ctc max'],
  salary_currency: ['salary_currency', 'currency'],
  salary_period: ['salary_period', 'period', 'salary period'],
  job_description: ['job_description', 'description', 'job description', 'jd'],
  about_job: ['about_job', 'about job', 'job summary'],
  hr_name: ['hr_name', 'contact name', 'name', 'full name', 'hr contact', 'hr name', 'recruiter', 'hiring manager'],
  hr_email: ['hr_email', 'email', 'email address', 'hr email', 'personal email', 'e mail', 'contact email'],
  hr_mobile: ['hr_mobile', 'mobile', 'phone', 'contact number', 'phone number', 'hr mobile', 'whatsapp', 'mobile number'],
  hr_linkedin_url: ['hr_linkedin_url', 'linkedin', 'linkedin url', 'hr linkedin', 'profile', 'linkedin profile'],
  pipeline_stage: ['pipeline_stage', 'stage', 'status'],
  score_band: ['score_band', 'band'],
  lead_score: ['lead_score', 'score', 'lead score'],
  notes: ['notes', 'note', 'comments', 'remark', 'remarks'],
};

/**
 * True when a value is just another field's canonical key spelled differently
 * ("company_name" under Company, "hr_email" under E-mail). Our slug folding makes
 * `field === value` match, so header-echo detection needs this separately: without it a
 * mis-parsed file creates a company literally named "company_name".
 */
export function isHeaderEcho(rec: Record<string, string>): boolean {
  const filled = Object.entries(rec).filter(([, v]) => (v ?? '').trim() !== '');
  if (filled.length === 0) return false;
  // Compare in the same slugged space as the headers, i.e. against the canonical field's
  // own name spelled like a header ("company_name" -> "company name"). Slugifying the key
  // instead would never match, because slugHeader turns underscores into spaces.
  const echoedHeaders = new Set<string>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) echoedHeaders.add(slugHeader(field));
  const echoCount = filled.filter(([, v]) => echoedHeaders.has(slugHeader(v))).length;
  // One coincidence is possible ("role" as a job title); most of the row being a key is not.
  return echoCount >= 2 && echoCount === filled.length;
}

/** canonical field -> where the imported value is written. */
export type ImportField =
  | 'company' | 'job' | 'contact' | 'lead';

export const FIELD_TARGET: Record<string, ImportField> = {
  lead_id: 'lead',
  company_name: 'company', company_domain: 'company', website_url: 'company',
  industry: 'company', size_estimate: 'company', default_email: 'company',
  default_phone: 'company', about_company: 'company',
  job_title: 'job', job_url: 'job', apply_url: 'job', source_site: 'job',
  department: 'job', openings_count: 'job', experience_level: 'job',
  employment_type: 'job', location_type: 'job', is_work_from_home: 'job',
  location: 'job', city: 'job', state: 'job', country: 'job',
  salary_range: 'job', salary_min: 'job', salary_max: 'job',
  salary_currency: 'job', salary_period: 'job',
  job_description: 'job', about_job: 'job', posted_at: 'job',
  hr_name: 'contact', hr_email: 'contact', hr_mobile: 'contact',
  hr_linkedin_url: 'contact', confidence_score: 'contact',
  pipeline_stage: 'lead', notes: 'lead',
};

/** Fields a row must have at least one of to be worth importing. */
export const IMPORT_MINIMUM_FIELDS = ['lead_id', 'company_name', 'job_title', 'job_url', 'hr_name', 'hr_email'];

export const slugHeader = (h: string) =>
  h.toLowerCase().replace(/^\ufeff/, '').replace(/[\s_\-]+/g, ' ').replace(/[.:]+$/g, '').trim();

/** canonical field -> the set of header texts that map to it (for header-as-data detection). */
export const HEADER_ALIAS_WORDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(HEADER_ALIASES).map(([field, aliases]) =>
    [field, new Set([slugHeader(field), ...aliases.map(slugHeader)])]),
);

/**
 * Map a raw header cell onto a canonical field name, or null when we do not know it.
 * Exact alias match wins; then substring match against aliases (longest alias first)
 * so "HR Email Address" still lands on hr_email instead of email.
 */
export function matchHeader(header: string): string | null {
  const h = slugHeader(header);
  if (!h) return null;
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (slugHeader(field) === h || aliases.some((a) => slugHeader(a) === h)) return field;
  }
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((a) => { const s = slugHeader(a); return s.length > 3 && (h.includes(s) || s.includes(h)); })) {
      return field;
    }
  }
  return null;
}

/** Turn parsed CSV rows into { canonicalField: value } records, dropping blanks. */
export function normaliseLeadRecords(table: string[][]): {
  records: Array<Record<string, string>>;
  mapped: Record<string, string>;   // canonical field -> original header
  unmapped: string[];               // headers we ignored
} {
  const headerRow = table[0] ?? [];
  const mapped: Record<string, string> = {};
  const unmapped: string[] = [];
  const indexes: Array<{ col: number; field: string }> = [];

  headerRow.forEach((raw, col) => {
    const field = matchHeader(raw);
    if (!field) { if (raw.trim()) unmapped.push(raw.trim()); return; }
    if (mapped[field]) return;            // first column wins for duplicate headers
    mapped[field] = raw.trim();
    indexes.push({ col, field });
  });

  const records = table.slice(1).map((row) => {
    const rec: Record<string, string> = {};
    for (const { col, field } of indexes) {
      const v = (row[col] ?? '').trim();
      // Our own export guards formulas with a leading apostrophe; undo that.
      rec[field] = v.startsWith("'") ? v.slice(1) : v;
    }
    return rec;
  }).filter((rec) => IMPORT_MINIMUM_FIELDS.some((f) => (rec[f] ?? '') !== ''));

  return { records, mapped, unmapped };
}

// ---------------------------------------------------------------------------
// Fingerprint — must match scrapers/normalizer.py generate_fingerprint() exactly
// ---------------------------------------------------------------------------

export function urlHostname(jobUrl: string): string {
  if (!jobUrl) return '';
  try {
    return new URL(jobUrl).hostname || '';
  } catch {
    return '';
  }
}

export function generateFingerprint(companyName: string, jobTitle: string, jobUrl: string): string {
  const normalizedCompany = (companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedTitle = (jobTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const input = `${normalizedCompany}|${normalizedTitle}|${urlHostname(jobUrl)}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Strict-dedup normalizers: the same real-world entity arrives spelled many ways
// ("Acme Pvt. Ltd." vs "acme", ".../jobs/1/" vs ".../jobs/1?utm=x"). Every lookup in
// the import ladder compares these canonical forms, so variants merge instead of
// duplicating. Fingerprint above is untouched (scraper parity).
// ---------------------------------------------------------------------------

/** Corporate suffixes stripped for identity comparison (not display). */
export const CORPORATE_SUFFIXES = [
  ' private limited', ' pvt ltd', ' pvt. ltd.', ' pvt', ' ltd', ' limited',
  ' llp', ' inc', ' corp', ' corporation', ' group', ' india',
];

/** Canonical company identity: lowercase, suffixes off, punctuation/spacing gone. */
export function normalizeCompanyKey(name: string | null | undefined): string {
  let s = (name || '').toLowerCase();
  for (const suffix of CORPORATE_SUFFIXES) s = s.split(suffix).join('');
  return s.replace(/[^a-z0-9]/g, '');
}

/**
 * Canonical job URL: trimmed, lowercased, query/fragment dropped, trailing slashes off.
 * Lowercasing the path is safe here (identity comparison only, never fetched).
 */
export function normalizeJobUrl(url: string | null | undefined): string {
  let s = (url || '').trim();
  if (!s) return '';
  s = s.split('#')[0].split('?')[0].trim().toLowerCase();
  s = s.replace(/\/+$/, '');
  return s;
}

/** Canonical LinkedIn URL for contact matching (vanity names are case-insensitive). */
export function normalizeLinkedin(url: string | null | undefined): string {
  let s = (url || '').trim();
  if (!s) return '';
  s = s.split('#')[0].split('?')[0].trim().toLowerCase().replace(/\/+$/, '');
  return s;
}

/** SQL expression for the canonical job URL of a stored posting (mirrors normalizeJobUrl). */
export const NORMALIZED_JOB_URL_SQL =
  `lower(regexp_replace(regexp_replace(jp.job_url, '[?#].*$', ''), '/+$', '', 'g'))`;

/** SQL expression for the canonical company key of a stored company (mirrors alnum fold). */
export const NORMALIZED_COMPANY_SQL =
  `regexp_replace(lower(name), '[^a-z0-9]', '', 'g')`;
