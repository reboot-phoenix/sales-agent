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
