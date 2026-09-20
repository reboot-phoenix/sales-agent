import type { MigrationContext } from 'node-pg-migrate';

// Stored freshness classification on job_postings (prompt §17: store
// posted_at, discovered_at/first_seen_at, freshness_category).
// NOT a GENERATED column: Postgres forbids non-immutable functions (NOW())
// in generated expressions. Instead the category is written at insert/merge
// time by every writer (scraper normalizer, CSV import) and reclassified
// nightly by the scheduler, so reads are a plain indexed column.
// Idempotent.
export const up = (pgm: MigrationContext) => {
  pgm.sql(`ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS freshness_category TEXT NOT NULL DEFAULT 'unknown'`);
  pgm.sql(`UPDATE job_postings SET freshness_category =
    CASE WHEN COALESCE(posted_at, first_seen_at) > NOW() - INTERVAL '24 hours' THEN 'fresh'
         WHEN COALESCE(posted_at, first_seen_at) > NOW() - INTERVAL '7 days' THEN 'recent'
         WHEN COALESCE(posted_at, first_seen_at) IS NULL THEN 'unknown'
         ELSE 'older' END
    WHERE freshness_category = 'unknown' OR freshness_category IS NULL`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_job_postings_freshness
    ON job_postings (freshness_category)`);
};

export const down = (pgm: MigrationContext) => {
  pgm.sql('DROP INDEX IF EXISTS idx_job_postings_freshness');
  pgm.sql('ALTER TABLE job_postings DROP COLUMN IF EXISTS freshness_category');
};
