import type { MigrationContext } from 'node-pg-migrate';

// Hackathon + College Intelligence domains, plus domain-agnostic lead ops.
//
// This is the forward-only delta for an ALREADY-DEPLOYED database. The same DDL
// also lives in database/schema/{tables,constraints,indexes} (the source of truth
// for a fresh install), so a new database and an upgraded one converge. Every
// statement is IF NOT EXISTS / guarded, so re-running is a no-op.
//
// Domains are deliberately isolated: hackathons and colleges do not share a
// generic table with job leads. Ownership/claim columns are per-domain so the
// atomic `UPDATE ... WHERE claimed_by IS NULL` race guard works identically in
// each domain without a polymorphic join.

const DDL = `
-- Organizer/canonical organization entity (shared by hackathons).
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  org_type TEXT CHECK (org_type IS NULL OR org_type IN
    ('company','college','university','community','ngo','government','foundation','other')),
  domain TEXT,
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

CREATE TABLE IF NOT EXISTS hackathons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  slug TEXT NOT NULL UNIQUE,
  organizer_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  organizer_name TEXT,
  organizer_type TEXT,
  organization_description TEXT,
  organizer_website TEXT,
  hackathon_url TEXT,
  registration_url TEXT,
  source_url TEXT,
  source_platform TEXT,
  event_type TEXT,
  hackathon_type TEXT,
  mode TEXT CHECK (mode IS NULL OR mode IN ('online','offline','hybrid')),
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
  technology TEXT,
  domain TEXT,
  tracks JSONB NOT NULL DEFAULT '[]',
  problem_statements JSONB NOT NULL DEFAULT '[]',
  themes JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  required_skills JSONB NOT NULL DEFAULT '[]',
  preferred_skills JSONB NOT NULL DEFAULT '[]',
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
  contact_name TEXT,
  contact_designation TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  contact_linkedin TEXT,
  contact_source TEXT,
  outreach_priority TEXT CHECK (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4')),
  outreach_status TEXT NOT NULL DEFAULT 'not_started',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  source_count INT NOT NULL DEFAULT 0,
  source_urls JSONB NOT NULL DEFAULT '[]',
  last_verified_at TIMESTAMPTZ,
  freshness_score SMALLINT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN
    ('DISCOVERED','CONFIRMED','ANNOUNCED','REGISTRATION_OPEN','UPCOMING','HISTORICAL',
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
  occurrence_type TEXT NOT NULL DEFAULT 'once',
  completeness_score SMALLINT NOT NULL DEFAULT 0,
  freshness_category TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'NEW',
  outreach_readiness TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (outreach_readiness IN
    ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA')),
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  raw_payload JSONB,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS hackathon_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE NOT NULL,
  full_name TEXT,
  designation TEXT,
  role_category TEXT NOT NULL DEFAULT 'organizer',
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
    NULLIF(email, '') IS NOT NULL OR NULLIF(phone, '') IS NOT NULL OR NULLIF(linkedin_url, '') IS NOT NULL)
);

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

CREATE TABLE IF NOT EXISTS colleges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  official_name TEXT,
  slug TEXT NOT NULL UNIQUE,
  aishe_code TEXT,
  university_affiliation TEXT,
  state TEXT,
  district TEXT,
  city TEXT,
  address TEXT,
  pincode TEXT,
  institution_type TEXT,
  ownership TEXT,
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
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verification_grade TEXT,
  source_count INT NOT NULL DEFAULT 0,
  source_urls JSONB NOT NULL DEFAULT '[]',
  last_verified_at TIMESTAMPTZ,
  freshness_score SMALLINT,
  confidence_score SMALLINT NOT NULL DEFAULT 0,
  contact_coverage JSONB NOT NULL DEFAULT '{}',
  completeness_score SMALLINT NOT NULL DEFAULT 0,
  freshness_category TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'NEW',
  outreach_readiness TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (outreach_readiness IN
    ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA')),
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  field_provenance JSONB NOT NULL DEFAULT '{}',
  raw_payload JSONB,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

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
    NULLIF(email, '') IS NOT NULL OR NULLIF(phone, '') IS NOT NULL OR NULLIF(linkedin_url, '') IS NOT NULL)
);

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

CREATE TABLE IF NOT EXISTS college_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID REFERENCES colleges(id) ON DELETE CASCADE NOT NULL,
  prediction_type TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS lead_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job','hackathon','college')),
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job','hackathon','college')),
  entity_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (trim(body) <> ''),
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job','hackathon','college')),
  entity_id UUID NOT NULL,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('job','hackathon','college')),
  entity_id UUID NOT NULL,
  claimed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS army_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
  run_type TEXT NOT NULL DEFAULT 'manual',
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

CREATE TABLE IF NOT EXISTS scraper_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  tier SMALLINT NOT NULL DEFAULT 3,
  enabled BOOLEAN NOT NULL DEFAULT true,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_error TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (domain, name)
);

CREATE TABLE IF NOT EXISTS raw_discovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
  source TEXT NOT NULL,
  source_url TEXT,
  checksum TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','processing','processed','failed','duplicate')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  error TEXT,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (domain, source, checksum)
);

CREATE TABLE IF NOT EXISTS scraper_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  domain TEXT NOT NULL,
  source TEXT NOT NULL,
  error TEXT NOT NULL,
  attempt SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
  entity_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stages JSONB NOT NULL DEFAULT '[]',
  attempts SMALLINT NOT NULL DEFAULT 0,
  contacts_found INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error JSONB
);

CREATE TABLE IF NOT EXISTS data_quality_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
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

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges','scraper')),
  metrics JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prediction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL CHECK (domain IN ('hackathons','colleges')),
  status TEXT NOT NULL DEFAULT 'running',
  method TEXT NOT NULL,
  entities_processed INT NOT NULL DEFAULT 0,
  predictions_created INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error JSONB
);
`;

const CONSTRAINTS = `
DO $$ BEGIN
  ALTER TABLE hackathons DROP CONSTRAINT IF EXISTS hackathons_prediction_needs_basis;
  ALTER TABLE hackathons ADD CONSTRAINT hackathons_prediction_needs_basis CHECK (
    status NOT IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION')
    OR NULLIF(trim(COALESCE(prediction_basis, '')), '') IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE hackathon_predictions DROP CONSTRAINT IF EXISTS hackathon_predictions_has_evidence;
  ALTER TABLE hackathon_predictions ADD CONSTRAINT hackathon_predictions_has_evidence CHECK (
    NULLIF(trim(basis), '') IS NOT NULL AND NULLIF(trim(method), '') IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE colleges DROP CONSTRAINT IF EXISTS colleges_aishe_not_blank;
  ALTER TABLE colleges ADD CONSTRAINT colleges_aishe_not_blank CHECK (
    aishe_code IS NULL OR trim(aishe_code) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE army_runs DROP CONSTRAINT IF EXISTS army_runs_counters_nonnegative;
  ALTER TABLE army_runs ADD CONSTRAINT army_runs_counters_nonnegative CHECK (
    sources_attempted >= 0 AND records_discovered >= 0 AND records_inserted >= 0
    AND duplicates_removed >= 0 AND contacts_discovered >= 0 AND errors_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_hackathons_status ON hackathons(status);
CREATE INDEX IF NOT EXISTS idx_hackathons_state ON hackathons(state);
CREATE INDEX IF NOT EXISTS idx_hackathons_city ON hackathons(city);
CREATE INDEX IF NOT EXISTS idx_hackathons_event_start ON hackathons(event_start);
CREATE INDEX IF NOT EXISTS idx_hackathons_registration_deadline ON hackathons(registration_deadline);
CREATE INDEX IF NOT EXISTS idx_hackathons_organizer ON hackathons(organizer_id);
CREATE INDEX IF NOT EXISTS idx_hackathons_mode ON hackathons(mode);
CREATE INDEX IF NOT EXISTS idx_hackathons_created ON hackathons(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hackathons_claimed ON hackathons(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hackathons_assigned ON hackathons(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hackathons_owner ON hackathons(assigned_to, claimed_by);
CREATE INDEX IF NOT EXISTS idx_hackathons_outreach ON hackathons(outreach_readiness);
CREATE INDEX IF NOT EXISTS idx_hackathons_freshness ON hackathons(freshness_category);
CREATE INDEX IF NOT EXISTS idx_hackathons_name_trgm ON hackathons USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hackathons_organizer_name_trgm ON hackathons USING gin (organizer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hackathon_occurrences_hackathon ON hackathon_occurrences(hackathon_id, year);
CREATE INDEX IF NOT EXISTS idx_hackathon_contacts_hackathon ON hackathon_contacts(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_contacts_email ON hackathon_contacts(lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_hackathon_sources_hackathon ON hackathon_sources(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_predictions_hackathon ON hackathon_predictions(hackathon_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_colleges_state ON colleges(state);
CREATE INDEX IF NOT EXISTS idx_colleges_district ON colleges(district);
CREATE INDEX IF NOT EXISTS idx_colleges_city ON colleges(city);
CREATE INDEX IF NOT EXISTS idx_colleges_type ON colleges(institution_type);
CREATE INDEX IF NOT EXISTS idx_colleges_ownership ON colleges(ownership);
CREATE INDEX IF NOT EXISTS idx_colleges_enrichment ON colleges(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_colleges_outreach ON colleges(outreach_readiness);
CREATE INDEX IF NOT EXISTS idx_colleges_freshness ON colleges(freshness_category);
CREATE INDEX IF NOT EXISTS idx_colleges_created ON colleges(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_colleges_claimed ON colleges(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_colleges_assigned ON colleges(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_colleges_owner ON colleges(assigned_to, claimed_by);
CREATE INDEX IF NOT EXISTS idx_colleges_name_trgm ON colleges USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_colleges_official_name_trgm ON colleges USING gin (official_name gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS uq_colleges_state_name
  ON colleges (lower(state), lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')))
  WHERE state IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_colleges_aishe
  ON colleges (aishe_code) WHERE aishe_code IS NOT NULL AND trim(aishe_code) <> '';
CREATE INDEX IF NOT EXISTS idx_college_contacts_college ON college_contacts(college_id);
CREATE INDEX IF NOT EXISTS idx_college_contacts_priority ON college_contacts(college_id, priority);
CREATE INDEX IF NOT EXISTS idx_college_contacts_email ON college_contacts(lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_college_sources_college ON college_sources(college_id);
CREATE INDEX IF NOT EXISTS idx_college_predictions_college ON college_predictions(college_id, generated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_name_type
  ON organizations (lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')), COALESCE(org_type, 'other'));
CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_activity_entity ON lead_activity(domain, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_notes_entity ON lead_notes(domain, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignments_entity ON lead_assignments(domain, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_claims_entity ON lead_claims(domain, entity_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_army_runs_domain_started ON army_runs(domain, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_army_runs_status ON army_runs(status);
CREATE INDEX IF NOT EXISTS idx_scraper_sources_domain ON scraper_sources(domain, enabled);
CREATE INDEX IF NOT EXISTS idx_raw_discovery_pending ON raw_discovery_records(domain, status, fetched_at) WHERE status IN ('stored','failed');
CREATE INDEX IF NOT EXISTS idx_raw_discovery_source ON raw_discovery_records(domain, source);
CREATE INDEX IF NOT EXISTS idx_scraper_errors_run ON scraper_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_scraper_errors_created ON scraper_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_entity ON enrichment_runs(domain, entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_quality_entity ON data_quality_results(domain, entity_id);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_domain ON analytics_snapshots(domain, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_domain ON prediction_runs(domain, started_at DESC);
`;

export const up = (pgm: MigrationContext) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  pgm.sql(DDL);
  pgm.sql(CONSTRAINTS);
  pgm.sql(INDEXES);
};

export const down = (pgm: MigrationContext) => {
  pgm.sql(`DROP TABLE IF EXISTS prediction_runs, analytics_snapshots, data_quality_results,
    enrichment_runs, scraper_errors, raw_discovery_records, scraper_sources, army_runs, lead_claims,
    lead_assignments, lead_notes, lead_activity, college_predictions, college_sources,
    college_contacts, colleges, hackathon_predictions, hackathon_sources,
    hackathon_contacts, hackathon_occurrences, hackathons, organizations CASCADE`);
};
