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
  -- Outreach readiness (see migration 014): denormalised so the outreach queue
  -- sorts and filters in the database rather than scoring inside a request.
  outreach_score SMALLINT NOT NULL DEFAULT 0,
  outreach_priority TEXT CHECK (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4')),
  outreach_readiness TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (outreach_readiness IN
    ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA')),
  outreach_assessed_at TIMESTAMPTZ,
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

-- ==================== [200_organizations.sql] ====================
-- Canonical ORGANIZATION entity shared by hackathon organizers (companies,
-- colleges, communities, foundations) and cross-source entity resolution.
-- A hackathon organizer is often also a company or a college; keeping one row
-- per real-world organization is what lets recurrence be measured per-organizer
-- instead of per-spelling-of-their-name.
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  org_type TEXT CHECK (org_type IS NULL OR org_type IN
    ('company', 'college', 'university', 'community', 'ngo', 'government', 'foundation', 'other')),
  domain TEXT,                                -- registrable domain (may be NULL)
  website_url TEXT,
  description TEXT,
  industry TEXT,
  country TEXT,
  state TEXT,
  city TEXT,
  linkedin_url TEXT,
  socials JSONB NOT NULL DEFAULT '{}',
  source_count INT NOT NULL DEFAULT 0,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [210_hackathons.sql] ====================
-- HACKATHON domain — canonical event entity. One row per real hackathon series
-- (e.g. "Smart India Hackathon"); each annual edition is a hackathon_occurrences
-- row. Never stores a predicted future edition as if it were confirmed: the
-- status column carries the explicit lifecycle/prediction label.
CREATE TABLE IF NOT EXISTS hackathons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  slug TEXT NOT NULL UNIQUE,
  organizer_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  -- Identity
  organizer_name TEXT,
  organizer_type TEXT,
  organization_description TEXT,
  organizer_website TEXT,
  hackathon_url TEXT,
  registration_url TEXT,
  source_url TEXT,
  source_platform TEXT,
  -- Event
  event_type TEXT,                            -- hackathon | ideathon | datathon | online_challenge
  hackathon_type TEXT,                        -- onsite | virtual | hybrid | online_challenge
  mode TEXT CHECK (mode IS NULL OR mode IN ('online', 'offline', 'hybrid')),
  venue TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  timezone TEXT,
  registration_start TIMESTAMPTZ,
  registration_deadline TIMESTAMPTZ,
  event_start TIMESTAMPTZ,
  event_end TIMESTAMPTZ,
  result_date TIMESTAMPTZ,
  team_size_min SMALLINT,
  team_size_max SMALLINT,
  eligibility TEXT,
  student_only BOOLEAN,
  college_only BOOLEAN,
  open_to_public BOOLEAN,
  age_limit TEXT,
  experience_requirement TEXT,
  -- Themes / technology
  technology TEXT,
  domain TEXT,
  tracks JSONB NOT NULL DEFAULT '[]',
  problem_statements JSONB NOT NULL DEFAULT '[]',
  themes JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  required_skills JSONB NOT NULL DEFAULT '[]',
  preferred_skills JSONB NOT NULL DEFAULT '[]',
  -- Competition
  prize_pool NUMERIC(14,2),
  first_prize NUMERIC(14,2),
  second_prize NUMERIC(14,2),
  third_prize NUMERIC(14,2),
  sponsor_prizes JSONB NOT NULL DEFAULT '[]',
  internship_opportunities BOOLEAN,
  hiring_opportunities BOOLEAN,
  certificates BOOLEAN,
  mentorship BOOLEAN,
  judging_criteria TEXT,
  -- Organizer contact block (publicly listed professional contact only)
  organizer_email TEXT,
  organizer_phone TEXT,
  organizer_linkedin TEXT,
  organizer_instagram TEXT,
  organizer_x TEXT,
  organizer_facebook TEXT,
  organizer_discord TEXT,
  organizer_community TEXT,
  organizer_contact_name TEXT,
  organizer_contact_designation TEXT,
  -- Outreach contact (best available ranked contact)
  contact_name TEXT,
  contact_designation TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contact_linkedin TEXT,
  contact_source TEXT,
  outreach_priority TEXT CHECK (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4')),
  outreach_status TEXT NOT NULL DEFAULT 'not_started',
  outreach_score SMALLINT NOT NULL DEFAULT 0,
  outreach_assessed_at TIMESTAMPTZ,
  -- Verification / provenance
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  source_count INT NOT NULL DEFAULT 0,
  source_urls JSONB NOT NULL DEFAULT '[]',
  last_verified_at TIMESTAMPTZ,
  freshness_score SMALLINT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  -- Lifecycle label. PREDICTED data must never render as CONFIRMED data.
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
    'DISCOVERED','CONFIRMED','ANNOUNCED','REGISTRATION_OPEN','UPCOMING','HISTORICAL',
    'RECURRING_PATTERN','PREDICTED','LOW_CONFIDENCE_PREDICTION')),
  historical_occurrence BOOLEAN NOT NULL DEFAULT false,
  recurrence_pattern TEXT,
  predicted_occurrence DATE,
  prediction_confidence SMALLINT,
  prediction_basis TEXT,
  historical_years JSONB NOT NULL DEFAULT '[]',
  expected_month SMALLINT,
  expected_registration_window TEXT,
  prediction_generated_at TIMESTAMPTZ,
  occurrence_type TEXT NOT NULL DEFAULT 'once',  -- once | recurring
  -- Data quality / outreach
  completeness_score SMALLINT NOT NULL DEFAULT 0,
  freshness_category TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'NEW',
  outreach_readiness TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (outreach_readiness IN
    ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA')),
  -- Ownership
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Dedup + provenance
  fingerprint TEXT NOT NULL UNIQUE,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  raw_payload JSONB,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [220_hackathon_occurrences.sql] ====================
-- Historical occurrences are NEVER overwritten: each annual edition of one
-- canonical hackathon is its own row, which is the raw material for EDA and
-- recurrence prediction.
CREATE TABLE IF NOT EXISTS hackathon_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE NOT NULL,
  year SMALLINT NOT NULL,
  edition TEXT,
  event_start DATE,
  event_end DATE,
  registration_start DATE,
  registration_deadline DATE,
  venue TEXT,
  city TEXT,
  state TEXT,
  mode TEXT,
  prize_pool NUMERIC(14,2),
  source_url TEXT,
  source_platform TEXT,
  is_confirmed BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (hackathon_id, year)
);

-- ==================== [230_hackathon_contacts.sql] ====================
CREATE TABLE IF NOT EXISTS hackathon_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE NOT NULL,
  full_name TEXT,
  designation TEXT,
  role_category TEXT NOT NULL DEFAULT 'organizer',  -- organizer | outreach | sponsor | judge
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  priority TEXT CHECK (priority IS NULL OR priority IN ('P0','P1','P2','P3','P4')),
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  contact_source TEXT,
  source_url TEXT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT hackathon_contacts_has_locator CHECK (
    NULLIF(email, '') IS NOT NULL OR NULLIF(phone, '') IS NOT NULL OR NULLIF(linkedin_url, '') IS NOT NULL
  )
);

-- ==================== [240_hackathon_sources.sql] ====================
CREATE TABLE IF NOT EXISTS hackathon_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE NOT NULL,
  source_platform TEXT NOT NULL,
  source_url TEXT NOT NULL,
  extraction_method TEXT,
  confidence SMALLINT,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  raw_payload JSONB,
  UNIQUE (hackathon_id, source_url)
);

-- ==================== [250_hackathon_predictions.sql] ====================
-- Every prediction carries its evidence, method and limitations. A prediction
-- row is never merged into a confirmed hackathon row.
CREATE TABLE IF NOT EXISTS hackathon_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE NOT NULL,
  predicted_occurrence DATE,
  expected_month SMALLINT,
  expected_registration_window TEXT,
  confidence SMALLINT NOT NULL DEFAULT 0,
  basis TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  historical_observations INT NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  limitations TEXT,
  status TEXT NOT NULL DEFAULT 'PREDICTED' CHECK (status IN
    ('PREDICTED','LOW_CONFIDENCE_PREDICTION','RECURRING_PATTERN')),
  generated_at TIMESTAMPTZ DEFAULT now(),
  run_id UUID
);

-- ==================== [260_colleges.sql] ====================
-- COLLEGE domain — canonical institution entity. state/district/city are the
-- backbones of the state-wise dataset; AISHE code is the strongest identity key.
CREATE TABLE IF NOT EXISTS colleges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  official_name TEXT,
  slug TEXT NOT NULL UNIQUE,
  aishe_code TEXT,                              -- unique when present (index below)
  university_affiliation TEXT,
  state TEXT,
  district TEXT,
  city TEXT,
  address TEXT,
  pincode TEXT,
  institution_type TEXT,                        -- college | university | institute | deemed
  ownership TEXT,                               -- government | private | aided | autonomous
  is_public BOOLEAN,
  autonomous BOOLEAN,
  accreditation TEXT,
  naac_grade TEXT,
  naac_score NUMERIC(4,2),
  nirf_rank INT,
  aicte_approved BOOLEAN,
  website_url TEXT,
  official_email TEXT,
  phone TEXT,
  admissions_contact TEXT,
  placement_contact TEXT,
  tpo_name TEXT,
  tpo_email TEXT,
  tpo_phone TEXT,
  placement_head_name TEXT,
  principal_name TEXT,
  director_name TEXT,
  dean_name TEXT,
  hod JSONB NOT NULL DEFAULT '[]',
  linkedin_url TEXT,
  socials JSONB NOT NULL DEFAULT '{}',
  programs JSONB NOT NULL DEFAULT '[]',
  -- Verification / provenance
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  source_count INT NOT NULL DEFAULT 0,
  source_urls JSONB NOT NULL DEFAULT '[]',
  last_verified_at TIMESTAMPTZ,
  freshness_score SMALLINT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  contact_coverage JSONB NOT NULL DEFAULT '{}',
  -- Data quality / outreach
  completeness_score SMALLINT NOT NULL DEFAULT 0,
  freshness_category TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'NEW',
  outreach_readiness TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (outreach_readiness IN
    ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA')),
  outreach_score SMALLINT NOT NULL DEFAULT 0,
  outreach_priority TEXT CHECK (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4')),
  outreach_assessed_at TIMESTAMPTZ,
  outreach_status TEXT NOT NULL DEFAULT 'not_started',
  -- Ownership
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Dedup + provenance
  fingerprint TEXT NOT NULL UNIQUE,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  raw_payload JSONB,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [270_college_contacts.sql] ====================
-- Priority order per spec: TPO -> Placement Head -> Director -> Principal ->
-- Dean -> HOD -> Placement Cell -> official institution contact -> other.
CREATE TABLE IF NOT EXISTS college_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID REFERENCES colleges(id) ON DELETE CASCADE NOT NULL,
  full_name TEXT,
  designation TEXT,
  role_category TEXT NOT NULL DEFAULT 'other' CHECK (role_category IN
    ('tpo','placement_head','placement_cell','director','principal','dean','hod','official','faculty','other')),
  priority TEXT NOT NULL DEFAULT 'P4' CHECK (priority IN ('P0','P1','P2','P3','P4')),
  department TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  contact_source TEXT,
  source_url TEXT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT college_contacts_has_locator CHECK (
    NULLIF(email, '') IS NOT NULL OR NULLIF(phone, '') IS NOT NULL OR NULLIF(linkedin_url, '') IS NOT NULL
  )
);

-- ==================== [280_college_sources.sql] ====================
CREATE TABLE IF NOT EXISTS college_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID REFERENCES colleges(id) ON DELETE CASCADE NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  extraction_method TEXT,
  confidence SMALLINT,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  raw_payload JSONB,
  UNIQUE (college_id, source_url)
);

-- ==================== [290_college_predictions.sql] ====================
CREATE TABLE IF NOT EXISTS college_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID REFERENCES colleges(id) ON DELETE CASCADE NOT NULL,
  prediction_type TEXT NOT NULL,               -- placement_season | admission_window | recruitment_drive
  predicted_window TEXT,
  expected_month SMALLINT,
  confidence SMALLINT NOT NULL DEFAULT 0,
  basis TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]',
  method TEXT NOT NULL,
  limitations TEXT,
  generated_at TIMESTAMPTZ DEFAULT now(),
  run_id UUID
);

-- ==================== [300_lead_activity.sql] ====================
-- Domain-agnostic activity/audit timeline for hackathon + college leads (job
-- leads keep using audit_log). `domain` isolates one domain's rows; entity_id
-- is the lead UUID in whichever domain table it belongs to.
CREATE TABLE IF NOT EXISTS lead_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job', 'hackathon', 'college')),
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [310_lead_notes.sql] ====================
CREATE TABLE IF NOT EXISTS lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job', 'hackathon', 'college')),
  entity_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (trim(body) <> ''),
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [320_lead_assignments.sql] ====================
-- Assignment history (append-only) so reassignment is auditable.
CREATE TABLE IF NOT EXISTS lead_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job', 'hackathon', 'college')),
  entity_id UUID NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [330_lead_claims.sql] ====================
-- Claim history. The live owner lives on the domain table (claimed_by) so the
-- atomic UPDATE ... WHERE claimed_by IS NULL remains the only write that can win
-- a race; this table records it for audit.
CREATE TABLE IF NOT EXISTS lead_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job', 'hackathon', 'college')),
  entity_id UUID NOT NULL,
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ DEFAULT now(),
  released_at TIMESTAMPTZ
);

-- ==================== [340_army_runs.sql] ====================
-- One row per army execution (job/hackathon/college), independent of the legacy
-- job-only scrape_runs table. Serializable so the UI can show live progress.
CREATE TABLE IF NOT EXISTS army_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  run_type TEXT NOT NULL DEFAULT 'manual',      -- manual | scheduled
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','running','completed','failed','partial','cancelled')),
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sources_attempted INT NOT NULL DEFAULT 0,
  sources_succeeded INT NOT NULL DEFAULT 0,
  records_discovered INT NOT NULL DEFAULT 0,
  records_inserted INT NOT NULL DEFAULT 0,
  records_updated INT NOT NULL DEFAULT 0,
  duplicates_removed INT NOT NULL DEFAULT 0,
  contacts_discovered INT NOT NULL DEFAULT 0,
  enrichments_done INT NOT NULL DEFAULT 0,
  predictions_generated INT NOT NULL DEFAULT 0,
  errors_count INT NOT NULL DEFAULT 0,
  retries INT NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL DEFAULT '{}',
  worker_status JSONB NOT NULL DEFAULT '[]',
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  error JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [350_scraper_sources.sql] ====================
-- Source registry per domain: adapter name + health. Distinct from source_health
-- (jobs) because hackathon/college adapters are versioned and toggleable.
CREATE TABLE IF NOT EXISTS scraper_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  tier SMALLINT NOT NULL DEFAULT 3,
  enabled BOOLEAN NOT NULL DEFAULT true,
  health_status TEXT NOT NULL DEFAULT 'unknown',  -- healthy | degraded | SOURCE_TEMPORARILY_UNAVAILABLE
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_error TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (domain, name)
);

-- ==================== [355_raw_discovery_records.sql] ====================
-- NO-LEAD-LOSS staging: every discovered item is written here BEFORE it is
-- parsed/normalized, in the same transaction boundary as the fetch. A crash in a
-- parser or normalizer therefore cannot lose a discovered lead: the row stays in
-- status 'stored' and is re-processed on the next boot/run (idempotent by
-- (domain, source, checksum)). This is the durable half of the pipeline
-- DISCOVER -> RAW -> NORMALIZE -> DEDUPE -> ENRICH -> VERIFY.
CREATE TABLE IF NOT EXISTS raw_discovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  source TEXT NOT NULL,
  source_url TEXT,
  checksum TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'processing', 'processed', 'failed', 'duplicate')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (domain, source, checksum)
);

-- ==================== [360_scraper_errors.sql] ====================
CREATE TABLE IF NOT EXISTS scraper_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  domain TEXT NOT NULL,
  source TEXT NOT NULL,
  error TEXT NOT NULL,
  attempt SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [370_enrichment_runs.sql] ====================
-- Domain-agnostic enrichment execution record (college contacts, hackathon
-- organizer contacts). Job enrichment keeps enrichment_jobs/enrichment_log.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  entity_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stages JSONB NOT NULL DEFAULT '[]',
  attempts SMALLINT NOT NULL DEFAULT 0,
  contacts_found INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error JSONB
);

-- ==================== [380_data_quality_results.sql] ====================
CREATE TABLE IF NOT EXISTS data_quality_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  entity_id UUID NOT NULL,
  completeness_score SMALLINT NOT NULL DEFAULT 0,
  freshness_score SMALLINT NOT NULL DEFAULT 0,
  verification_score SMALLINT NOT NULL DEFAULT 0,
  source_quality TEXT,
  contact_quality TEXT,
  confidence SMALLINT NOT NULL DEFAULT 0,
  quality_state TEXT NOT NULL DEFAULT 'NEW' CHECK (quality_state IN
    ('NEW','DISCOVERED','NORMALIZED','ENRICHING','ENRICHED','VERIFIED','NEEDS_REVIEW','STALE','FAILED')),
  issues JSONB NOT NULL DEFAULT '[]',
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (domain, entity_id)
);

-- ==================== [390_analytics_snapshots.sql] ====================
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges', 'scraper')),
  metrics JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== [400_prediction_runs.sql] ====================
CREATE TABLE IF NOT EXISTS prediction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('hackathons', 'colleges')),
  status TEXT NOT NULL DEFAULT 'running',
  method TEXT NOT NULL,
  entities_processed INT NOT NULL DEFAULT 0,
  predictions_created INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error JSONB
);

-- ==================== [410_saved_filters.sql] ====================
-- Named, reusable filter sets per user and domain. Shared filters are visible to
-- the whole team; private ones only to their owner (enforced in the route).
CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('jobs', 'hackathons', 'colleges')),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  filters JSONB NOT NULL DEFAULT '{}',
  is_shared BOOLEAN NOT NULL DEFAULT false,
  use_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, domain, name)
);
