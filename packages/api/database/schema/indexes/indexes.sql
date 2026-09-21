-- indexes/indexes.sql — single source of truth for INDEXES (fresh-install schema).
-- Sections below are the former split files, kept in dependency order.
-- Idempotent: safe to re-run on every boot. Deployed-DB deltas live in database/migrations/.

-- ==================== [010_job_postings.sql] ====================
-- Concern: INDEXES (job_postings). Justified by the leads list join/filters
-- (source_site, experience_level) + dedup (fingerprint is the UNIQUE key) +
-- daily "active, recently seen" discovery sweep.
CREATE INDEX IF NOT EXISTS idx_jobposting_active ON job_postings(is_active, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_jobposting_source_site ON job_postings(source_site);
CREATE INDEX IF NOT EXISTS idx_jobposting_experience ON job_postings(experience_level);

-- ==================== [020_leads.sql] ====================
-- Concern: INDEXES (leads). Each matches a concrete query in routes/leads.ts +
-- routes/dashboard.ts (RBAC list, stage funnel, score band + sort, contactability).
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_score_band ON leads(score_band, lead_score DESC);
-- RBAC: sales_rep listing filters assigned_to then sorts by the requested column.
CREATE INDEX IF NOT EXISTS idx_leads_assigned_created ON leads(assigned_to, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_score ON leads(assigned_to, lead_score DESC);
-- Ownership: claim/assign + My Leads (claimed_by OR assigned_to) must stay indexed.
-- Guarded by column/table existence: on an already-deployed DB the columns arrive
-- via migrations/009 (npm run migrate), and the next schema pass creates the indexes.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'claimed_by') THEN
    CREATE INDEX IF NOT EXISTS idx_leads_claimed_by ON leads(claimed_by);
    CREATE INDEX IF NOT EXISTS idx_leads_claimed_created ON leads(claimed_by, created_at DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'enrichment_jobs') THEN
    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_lead ON enrichment_jobs(lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status);
  END IF;
END $$;
-- Do-not-contact filtering (hot path on the send guard + list default view).
-- FKs from leads (Postgres does NOT auto-index referencing side of FKs).
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id);
CREATE INDEX IF NOT EXISTS idx_leads_hr_contact ON leads(hr_contact_id);

-- ==================== [030_outreach.sql] ====================
-- Concern: INDEXES (outreach_log, outreach_drafts). Send history per lead +
-- the anti-spam cooldown lookup (lead_id+channel ordered by sent_at) and draft
-- versioning lookup.
CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON outreach_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_log_lead_channel_time ON outreach_log(lead_id, channel, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_log_sent_at ON outreach_log(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_lead_channel ON outreach_drafts(lead_id, channel, version);

-- ==================== [040_audit.sql] ====================
-- Concern: INDEXES (audit_log, verification_log, enrichment_log).
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_verification_log_lead ON verification_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_log_lead ON enrichment_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_log_created ON enrichment_log(created_at DESC);

-- ==================== [050_suppressions.sql] ====================
-- Concern: INDEXES (suppressions). The server-side suppression check runs on
-- EVERY outbound message keyed by normalized_contact -> must be a unique scan.
CREATE INDEX IF NOT EXISTS idx_suppressions_contact ON suppressions(normalized_contact);

-- ==================== [055_outreach_tokens.sql] ====================
CREATE INDEX IF NOT EXISTS idx_outreach_tokens_contact ON outreach_tokens(normalized_contact);

-- ==================== [060_identity_lookup.sql] ====================
-- Concern: INDEXES (contact identity, non-unique). The app canonicalises people
-- by case-insensitive email/phone for dedup + suppression joins. These are
-- deliberately NON-unique: a generic HR (hr@corp) legitimately recurs across
-- leads at the same company, and the spec forbids auto-merging low-confidence
-- identities. Expression indexes (lower()) let those lookups use the index.
CREATE INDEX IF NOT EXISTS idx_hr_email_lookup ON hr_contacts(lower(personal_email))
  WHERE personal_email IS NOT NULL AND personal_email <> '';
CREATE INDEX IF NOT EXISTS idx_hr_mobile_lookup ON hr_contacts(personal_mobile)
  WHERE personal_mobile IS NOT NULL AND personal_mobile <> '';
CREATE INDEX IF NOT EXISTS idx_hr_linkedin_lookup ON hr_contacts(lower(linkedin_url))
  WHERE linkedin_url IS NOT NULL;

-- ==================== [070_trgm_search.sql] ====================
-- Concern: INDEXES (fuzzy search). The leads list `filter` runs ILIKE '%term%'
-- across company name/domain and job title. A plain btree can't serve a leading
-- wildcard; GIN + pg_trgm can. Requires the pg_trgm extension (schema/tables/000).
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_companies_domain_trgm ON companies USING gin (domain gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_jobposting_title_trgm ON job_postings USING gin (title gin_trgm_ops);
-- Contacts page searches hr name/email with ILIKE '%term%': same treatment.
CREATE INDEX IF NOT EXISTS idx_hrcontacts_name_trgm ON hr_contacts USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hrcontacts_email_trgm ON hr_contacts USING gin (personal_email gin_trgm_ops);

-- HR contact reuse is scoped per employer (migration 006): one company must not
-- hold two rows for the same email or LinkedIn profile. Global uniqueness on
-- linkedin_url alone is still enforced by the table constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hrcontacts_company_email
  ON hr_contacts (current_company_id, lower(personal_email))
  WHERE personal_email IS NOT NULL AND personal_email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_hrcontacts_company_linkedin
  ON hr_contacts (current_company_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL AND linkedin_url <> '';

-- ==================== [080_company_name_unique.sql] ====================
-- companies.domain is UNIQUE but companies.name was not, so a CSV import could create
-- "Acme" twice and every later lookup ("SELECT id FROM companies WHERE name = $1")
-- then picked one at random. The import's ON CONFLICT (lower(name)) needs this index
-- to exist; it also stops the scrapers inserting case-variant duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_key ON companies (lower(name));

-- The CSV importer's near-duplicate probe compares normalized company name + trigram
-- similarity of the title, so it needs pg_trgm and an index on the company key. Without
-- the index every imported row would sequential-scan companies/job_postings.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_companies_name_alnum ON companies (lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')));
-- idx_jobposting_title_trgm (above) already covers trigram similarity on
-- job_postings.title; the duplicate idx_jobpostings_title_trgm_sim was removed.
-- Inbound webhook dedup: provider retries must not insert the same message twice.
-- UNIQUE enforces it; the existing non-unique inbound_provider_msg_idx remains as
-- the lookup path for the webhook handler.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_provider_msg ON inbound_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ==================== [090_intelligence_domains.sql] ====================
-- Concern: INDEXES for the hackathon/college intelligence domains. Each matches a
-- concrete query in routes/hackathons.ts, routes/colleges.ts and the army/EDA
-- workers (filter by state/city/organizer/status/month; ownership; freshness;
-- prediction lookup; FK-side joins).

-- Hackathons: list filters + ownership + upcoming/registration windows.
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
-- Recurrence detection groups occurrences per canonical hackathon ordered by year.
CREATE INDEX IF NOT EXISTS idx_hackathon_occurrences_hackathon ON hackathon_occurrences(hackathon_id, year);
CREATE INDEX IF NOT EXISTS idx_hackathon_contacts_hackathon ON hackathon_contacts(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_contacts_email ON hackathon_contacts(lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_hackathon_sources_hackathon ON hackathon_sources(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_predictions_hackathon ON hackathon_predictions(hackathon_id, generated_at DESC);

-- Colleges: state-wise dataset, enrichment coverage, ownership, fuzzy search.
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
-- Institution must not appear twice under the same state; a cross-state name
-- collision is legitimate (many "Government Engineering College" exist).
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

-- Organizations + domain-agnostic lead ops.
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
-- Outreach queue: the hottest sendable leads per domain, and the readiness mix.
CREATE INDEX IF NOT EXISTS idx_leads_outreach_score ON leads(outreach_score DESC) WHERE do_not_contact = false;
CREATE INDEX IF NOT EXISTS idx_leads_outreach_readiness ON leads(outreach_readiness);
CREATE INDEX IF NOT EXISTS idx_hackathons_outreach_score ON hackathons(outreach_score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_colleges_outreach_score ON colleges(outreach_score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_colleges_outreach_priority ON colleges(outreach_priority)
  WHERE outreach_priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_filters_owner ON saved_filters(user_id, domain, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_filters_shared ON saved_filters(domain) WHERE is_shared;
