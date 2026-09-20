-- tables/tables.sql — single source of truth for TABLES (fresh-install schema).
-- Sections below are the former split files, kept in dependency order.
-- Idempotent: safe to re-run on every boot. Deployed-DB deltas live in database/migrations/.

-- ==================== [000_extensions.sql] ====================
-- Extensions (applied first; other objects depend on them).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email equality
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram fuzzy search (ILIKE / similarity)

-- ==================== [010_companies.sql] ====================
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  domain TEXT UNIQUE,
  about TEXT,
  industry TEXT,
  size_estimate TEXT,
  default_email TEXT,
  default_phone TEXT,
  website_url TEXT,
  -- Firmographics (Apollo org / OSINT). NULL = unknown, never guessed.
  employee_count INT,
  revenue TEXT,
  founded_year SMALLINT,
  tech_stack JSONB NOT NULL DEFAULT '[]',
  linkedin_url TEXT,
  twitter_url TEXT,
  city TEXT,
  country TEXT,
  -- Per-field provenance: { column: { source, verified, at } }. Lets merges
  -- prefer stronger verified values and keeps every figure explainable.
  field_provenance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [020_hr_contacts.sql] ====================
CREATE TABLE IF NOT EXISTS hr_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT,
  -- UNIQUE here allows many NULLs; empty strings are normalised to NULL by
  -- migration 006 so a missing value can never satisfy an equality match.
  linkedin_url TEXT UNIQUE,
  personal_email TEXT,
  personal_mobile TEXT,
  current_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  confidence_score SMALLINT DEFAULT 0,
  contact_source TEXT,                    -- direct_extracted | search_discovered | osint_discovered | whois_discovered | provider_enriched | pattern_generated
  contact_method TEXT,                    -- how the contact was found (e.g., career_page_regex, ddg_dork, whois)
  contact_url TEXT,                       -- URL where the contact was found
  extraction_provenance JSONB,            -- full audit trail of extraction stages
  -- Person enrichment (Apollo/Lusha/RocketReach/LinkedIn). NULL/empty = unknown.
  job_title TEXT,
  department TEXT,
  seniority TEXT,
  location TEXT,
  emails JSONB NOT NULL DEFAULT '[]',    -- extra verified emails beyond personal_email
  phones JSONB NOT NULL DEFAULT '[]',    -- extra phones beyond personal_mobile
  email_verified BOOLEAN NOT NULL DEFAULT false,
  socials JSONB NOT NULL DEFAULT '{}',   -- { twitter, github, facebook, ... }
  field_provenance JSONB NOT NULL DEFAULT '{}',  -- per-field { source, verified, at }
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  -- A contact needs one real way to reach the person, unless retention has
  -- anonymised it (scheduler.enforce_retention blanks locators on purpose).
  -- COALESCE matters: `NULL jsonb ? key` is NULL and a NULL CHECK result passes.
  CONSTRAINT hr_contacts_has_locator CHECK (
    NULLIF(linkedin_url, '') IS NOT NULL
    OR NULLIF(personal_email, '') IS NOT NULL
    OR NULLIF(personal_mobile, '') IS NOT NULL
    OR COALESCE(extraction_provenance ? 'retained_anonymised_at', false)
  )
);

-- ==================== [030_users.sql] ====================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'sales_rep',
  api_keys JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [040_job_postings.sql] ====================
CREATE TABLE IF NOT EXISTS job_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  hr_contact_id UUID REFERENCES hr_contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  experience_level TEXT,
  salary_range TEXT,
  job_url TEXT NOT NULL,
  source_site TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  raw_payload JSONB,
  parser_version TEXT,
  content_hash TEXT,
  -- Posting facets. Declared here so a FRESH install matches an upgraded one:
  -- these previously existed only in migration 007, which never runs against a
  -- new database, so every insert_lead() crashed with UndefinedColumnError.
  location TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  location_type TEXT CHECK (location_type IN ('remote', 'onsite', 'hybrid')),
  employment_type TEXT,
  is_work_from_home BOOLEAN DEFAULT false,
  apply_url TEXT,
  posted_at TIMESTAMPTZ,
  -- Stored freshness label (fresh <24h / recent <7d / older / unknown).
  -- Plain column, NOT GENERATED: Postgres forbids NOW() (non-immutable) in
  -- generated expressions. Writers set it at insert/merge; the daily scheduler
  -- reclassifies aging rows. Reads stay a cheap indexed equality.
  freshness_category TEXT NOT NULL DEFAULT 'unknown',
  about_job TEXT,
  department TEXT,
  openings_count INTEGER,
  salary_min NUMERIC(14,2),
  salary_max NUMERIC(14,2),
  salary_currency TEXT,
  salary_period TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true
);

-- ==================== [050_leads.sql] ====================
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id UUID UNIQUE REFERENCES job_postings(id) ON DELETE CASCADE NOT NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  hr_contact_id UUID REFERENCES hr_contacts(id) ON DELETE SET NULL,
  lead_score SMALLINT DEFAULT 0,
  score_band TEXT GENERATED ALWAYS AS (
    CASE WHEN lead_score >= 70 THEN 'hot'
         WHEN lead_score >= 40 THEN 'warm'
         ELSE 'cold' END
  ) STORED,
  pipeline_stage TEXT DEFAULT 'discovered',
  legal_basis TEXT DEFAULT 'legitimate_interest_b2b',
  processing_purpose TEXT DEFAULT 'b2b_recruitment_outreach',
  provenance JSONB,
  data_quality TEXT DEFAULT 'complete',
  email_status TEXT,
  whatsapp_status TEXT,
  do_not_contact BOOLEAN DEFAULT false,
  possible_duplicate_of UUID REFERENCES leads(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  hr_extraction_provenance JSONB,            -- SRS §4.5 provenance audit trail
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [055_enrichment_jobs.sql] ====================
CREATE TABLE IF NOT EXISTS enrichment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'queued',
  attempts SMALLINT NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  error JSONB,
  result_summary JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [060_enrichment_log.sql] ====================
CREATE TABLE IF NOT EXISTS enrichment_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  request_payload JSONB,
  response_payload JSONB,
  credits_used INT DEFAULT 1,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [065_verification_log.sql] ====================
CREATE TABLE IF NOT EXISTS verification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  channel TEXT NOT NULL,
  result TEXT NOT NULL,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [070_outreach_drafts.sql] ====================
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  channel TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  subject TEXT,
  body TEXT NOT NULL,
  generated_by TEXT DEFAULT 'gemini-2.5-flash',
  is_edited BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [080_outreach_log.sql] ====================
CREATE TABLE IF NOT EXISTS outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE NOT NULL,
  draft_id UUID REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  delivery_status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [090_inbound_messages.sql] ====================
/*
 * Inbound correspondence.

 * The Resend/WhatsApp webhook already detects replies (webhooks.ts sets
 * outreach_log.delivery_status = 'replied' and moves the lead stage), but it keeps
 * no copy of what the person wrote. That means a follow-up draft cannot see an
 * objection, an unsubscribe request, or "send this to my manager" -- it would reply
 * as if nothing had happened.

 * Outbound history needed NO new table: outreach_log.draft_id joins to
 * outreach_drafts.subject/body, so everything we sent is already reconstructable.
 * This stores only the inbound direction, which genuinely has nowhere to live.

 * GDPR: erasure must clear this too -- it holds raw third-party message content.
 */

CREATE TABLE IF NOT EXISTS inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    outreach_log_id UUID REFERENCES outreach_log(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
    sender_identity TEXT,
    subject TEXT,
    body_text TEXT NOT NULL,
    provider_message_id TEXT,
    -- Unsubscribe / do-not-contact intent detected in the text, so compliance can
    -- act on it without re-reading bodies.
    is_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS inbound_lead_recent_idx
    ON inbound_messages (lead_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_provider_msg_idx
    ON inbound_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

COMMENT ON TABLE inbound_messages IS
    'Inbound replies only; outbound lives in outreach_drafts joined via outreach_log.';

-- ==================== [090_scrape_runs.sql] ====================
CREATE TABLE IF NOT EXISTS scrape_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sources_attempted INT,
  sources_succeeded INT,
  sources_circuit_broken TEXT[],
  leads_found INT,
  leads_deduped INT,
  errors JSONB
);

-- ==================== [100_source_health.sql] ====================
CREATE TABLE IF NOT EXISTS source_health (
  source_name TEXT PRIMARY KEY,
  consecutive_failures INT DEFAULT 0,
  circuit_open_until TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_reason TEXT
);

-- ==================== [110_audit_log.sql] ====================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [120_settings.sql] ====================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [130_suppressions.sql] ====================
-- Do-not-contact / suppression store: server-side opt-out + manual/bounce/
-- compliance suppression, keyed by normalized contact so a person is suppressed
-- across all leads. Read+written by send worker, webhook and admin controls.
CREATE TABLE IF NOT EXISTS suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_contact TEXT NOT NULL,          -- lower(email) or E.164 phone
  channel TEXT NOT NULL DEFAULT 'any',       -- email | whatsapp | any
  reason TEXT NOT NULL,                      -- opted_out | bounced | blocked | compliance_hold | manual
  source TEXT,                               -- webhook | manual | provider | admin
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (normalized_contact, channel)
);

-- ==================== [140_daily_runs.sql] ====================
-- Daily-run guard so running the same discovery job twice does not double-process.
CREATE TABLE IF NOT EXISTS daily_runs (
  run_date DATE PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',    -- running | completed | failed
  leads_found INT DEFAULT 0
);

-- ==================== [150_outreach_tokens.sql] ====================
-- RFC-8058 one-click unsubscribe: opaque, unguessable token -> recipient contact.
-- Minted at send time so the "unsubscribe" link carries ONLY the token, never an
-- email/phone. This is what makes the public /optout route safe against arbitrary
-- blocklist poisoning (a caller can only act on a token we issued) AND keeps PII
-- out of URLs, request logs, Referer headers and browser history.
CREATE TABLE IF NOT EXISTS outreach_tokens (
  token TEXT PRIMARY KEY,                    -- opaque random (secrets.token_urlsafe)
  normalized_contact TEXT NOT NULL,          -- lower(email) or E.164 phone
  channel TEXT NOT NULL DEFAULT 'email',     -- email | whatsapp
  created_at TIMESTAMPTZ DEFAULT now()
);
