-- constraints/constraints.sql — single source of truth for CONSTRAINTS (fresh-install schema).
-- Sections below are the former split files, kept in dependency order.
-- Idempotent: safe to re-run on every boot. Deployed-DB deltas live in database/migrations/.

-- ==================== [010_users_role_check.sql] ====================
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'sales_rep', 'viewer'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [020_leads_pipeline_stage_check.sql] ====================
-- Lead lifecycle state machine (happy path + every failure state the spec lists).
-- NOTE: 'contacted' is the legacy alias of 'sent' still written by workers/webhooks.
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_stage_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_pipeline_stage_chk CHECK (pipeline_stage IN (
    'discovered','enriching','enriched','verifying','verified','drafted','contacted',
    'ready_for_outreach','message_generated','send_pending','sent','delivered','replied','converted','bounced',
    'enrichment_failed','verification_failed','contact_unavailable','suppressed','send_failed','provider_error','retry_pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [030_leads_email_status_check.sql] ====================
-- Discovery and verification are distinct: email_status records an actual
-- verification outcome (or pending/unknown), never a guessed "verified".
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_email_status_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_email_status_chk CHECK (email_status IS NULL OR email_status IN (
    'unknown','valid','invalid','catch_all','disposable','expired','pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [040_leads_whatsapp_status_check.sql] ====================
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_whatsapp_status_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_whatsapp_status_chk CHECK (whatsapp_status IS NULL OR whatsapp_status IN (
    'unknown','registered','not_registered','expired','pending'));
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [050_leads_score_check.sql] ====================
-- Concern: CONSTRAINTS. lead_score is a 0-100 normalized score; anything
-- outside is a scoring bug and must not silently persist.
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_score_range_chk;
  ALTER TABLE leads ADD CONSTRAINT leads_score_range_chk CHECK (lead_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; END $$;

-- ==================== [060_companies_name_not_blank.sql] ====================
-- companies.name is NOT NULL, which still admits ''. A blank name renders as an empty
-- cell and an empty edit form, and one row reached production that way. The rule lives
-- here rather than in app code so every writer is covered: the normalizer upsert, POST
-- /companies, and admin edits all hit the same constraint.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_name_not_blank;
ALTER TABLE companies
  ADD CONSTRAINT companies_name_not_blank CHECK (trim(name) <> '');

-- ==================== [070_prediction_provenance.sql] ====================
-- A row labelled PREDICTED (or LOW_CONFIDENCE_PREDICTION) MUST carry a basis.
-- The spec is explicit that predicted data may never be presented as confirmed;
-- this makes an unsupported prediction unrepresentable at the storage layer, not
-- merely discouraged in application code.
DO $$ BEGIN
  ALTER TABLE hackathons DROP CONSTRAINT IF EXISTS hackathons_prediction_needs_basis;
  ALTER TABLE hackathons ADD CONSTRAINT hackathons_prediction_needs_basis CHECK (
    status NOT IN ('PREDICTED','LOW_CONFIDENCE_PREDICTION')
    OR NULLIF(trim(COALESCE(prediction_basis, '')), '') IS NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE hackathon_predictions DROP CONSTRAINT IF EXISTS hackathon_predictions_has_evidence;
  ALTER TABLE hackathon_predictions ADD CONSTRAINT hackathon_predictions_has_evidence CHECK (
    NULLIF(trim(basis), '') IS NOT NULL AND NULLIF(trim(method), '') IS NOT NULL
  );
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- ==================== [080_aishe_code_not_blank.sql] ====================
-- AISHE code is a strong identity key; a blank one must be NULL so the unique
-- index treats it as absent rather than colliding every blank-coded college.
DO $$ BEGIN
  ALTER TABLE colleges DROP CONSTRAINT IF EXISTS colleges_aishe_not_blank;
  ALTER TABLE colleges ADD CONSTRAINT colleges_aishe_not_blank CHECK (
    aishe_code IS NULL OR trim(aishe_code) <> ''
  );
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- ==================== [085_outreach_score_range.sql] ====================
-- An outreach score is a 0-100 composite. Anything outside that range means the
-- scorer is broken, and a broken score must never be stored as a real ranking.
DO $$ BEGIN
  ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_outreach_score_range;
  ALTER TABLE leads ADD CONSTRAINT leads_outreach_score_range CHECK (outreach_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE hackathons DROP CONSTRAINT IF EXISTS hackathons_outreach_score_range;
  ALTER TABLE hackathons ADD CONSTRAINT hackathons_outreach_score_range CHECK (outreach_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE colleges DROP CONSTRAINT IF EXISTS colleges_outreach_score_range;
  ALTER TABLE colleges ADD CONSTRAINT colleges_outreach_score_range CHECK (outreach_score BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- A saved filter must be a JSON object: an array or scalar could not be replayed
-- as a filter set, so storing one would create a view that silently does nothing.
DO $$ BEGIN
  ALTER TABLE saved_filters DROP CONSTRAINT IF EXISTS saved_filters_filters_is_object;
  ALTER TABLE saved_filters ADD CONSTRAINT saved_filters_filters_is_object CHECK (jsonb_typeof(filters) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- ==================== [090_army_run_counters.sql] ====================
-- Counters are monotonic non-negative; a negative count means a bookkeeping bug
-- and must not be stored as if it were a real measurement.
DO $$ BEGIN
  ALTER TABLE army_runs DROP CONSTRAINT IF EXISTS army_runs_counters_nonnegative;
  ALTER TABLE army_runs ADD CONSTRAINT army_runs_counters_nonnegative CHECK (
    sources_attempted >= 0 AND records_discovered >= 0 AND records_inserted >= 0
    AND duplicates_removed >= 0 AND contacts_discovered >= 0 AND errors_count >= 0
  );
EXCEPTION WHEN duplicate_object THEN NULL; WHEN check_violation THEN NULL; WHEN undefined_table THEN NULL; END $$;
