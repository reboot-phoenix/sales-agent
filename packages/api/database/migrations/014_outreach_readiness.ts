import type { MigrationContext } from 'node-pg-migrate';

// Outreach readiness as a first-class, queryable property of every lead.
//
// The scores are computed by the enrichment workers (python) and by the API when
// a row has never been assessed. Storing them means the outreach queue can sort
// and filter hundreds of thousands of leads in the database instead of scoring in
// a request, and it lets an operator see exactly which leads were last assessed.
//
// `saved_filters` backs the per-domain saved views in the UI: one row is one
// named filter set belonging to one user and one domain.
//
// Every statement is idempotent (IF NOT EXISTS / guarded DO block), so running
// this against a database that already has some of the columns is a no-op.

const DDL = `
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS outreach_score       SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS outreach_priority    TEXT;
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS outreach_readiness   TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA';
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS outreach_assessed_at TIMESTAMPTZ;

ALTER TABLE hackathons ADD COLUMN IF NOT EXISTS outreach_score       SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE hackathons ADD COLUMN IF NOT EXISTS outreach_assessed_at TIMESTAMPTZ;

ALTER TABLE colleges   ADD COLUMN IF NOT EXISTS outreach_score       SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE colleges   ADD COLUMN IF NOT EXISTS outreach_priority    TEXT;
ALTER TABLE colleges   ADD COLUMN IF NOT EXISTS outreach_assessed_at TIMESTAMPTZ;
-- Colleges need the same outreach workflow state hackathons already had.
ALTER TABLE colleges   ADD COLUMN IF NOT EXISTS outreach_status      TEXT NOT NULL DEFAULT 'not_started';

-- Readiness vocabulary is shared by every domain so a queue can union them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_outreach_readiness_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_outreach_readiness_check CHECK (outreach_readiness IN
      ('OUTREACH_READY','PARTIALLY_ENRICHED','NEEDS_ENRICHMENT','INSUFFICIENT_DATA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_outreach_priority_check') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_outreach_priority_check CHECK
      (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'colleges_outreach_priority_check') THEN
    ALTER TABLE colleges ADD CONSTRAINT colleges_outreach_priority_check CHECK
      (outreach_priority IS NULL OR outreach_priority IN ('P0','P1','P2','P3','P4'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saved_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('jobs','hackathons','colleges')),
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  filters JSONB NOT NULL DEFAULT '{}',
  is_shared BOOLEAN NOT NULL DEFAULT false,
  use_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  -- One name per user per domain: saving "My TPO backlog" twice updates it.
  UNIQUE (user_id, domain, name)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_leads_outreach_score ON leads(outreach_score DESC) WHERE do_not_contact = false;
CREATE INDEX IF NOT EXISTS idx_leads_outreach_readiness ON leads(outreach_readiness);
CREATE INDEX IF NOT EXISTS idx_hackathons_outreach_score ON hackathons(outreach_score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_colleges_outreach_score ON colleges(outreach_score DESC) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_colleges_outreach_priority ON colleges(outreach_priority)
  WHERE outreach_priority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_filters_owner ON saved_filters(user_id, domain, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_filters_shared ON saved_filters(domain) WHERE is_shared;
`;

export const up = (pgm: MigrationContext) => {
  pgm.sql(DDL);
  pgm.sql(INDEXES);
};

export const down = (pgm: MigrationContext) => {
  pgm.sql('DROP TABLE IF EXISTS saved_filters');
  pgm.sql(`
    ALTER TABLE leads      DROP COLUMN IF EXISTS outreach_score;
    ALTER TABLE leads      DROP COLUMN IF EXISTS outreach_priority;
    ALTER TABLE leads      DROP COLUMN IF EXISTS outreach_readiness;
    ALTER TABLE leads      DROP COLUMN IF EXISTS outreach_assessed_at;
    ALTER TABLE hackathons DROP COLUMN IF EXISTS outreach_score;
    ALTER TABLE hackathons DROP COLUMN IF EXISTS outreach_assessed_at;
    ALTER TABLE colleges   DROP COLUMN IF EXISTS outreach_score;
    ALTER TABLE colleges   DROP COLUMN IF EXISTS outreach_priority;
    ALTER TABLE colleges   DROP COLUMN IF EXISTS outreach_assessed_at;
    ALTER TABLE colleges   DROP COLUMN IF EXISTS outreach_status;
  `);
};
