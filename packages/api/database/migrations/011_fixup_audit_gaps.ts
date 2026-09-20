import type { MigrationContext } from 'node-pg-migrate';

// Fixup audit gaps: dedup inbound webhook inserts + drop redundant trigram index.
// Mirrors schema/indexes/indexes.sql. Idempotent.
export const up = (pgm: MigrationContext) => {
  pgm.sql('CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_provider_msg ON inbound_messages (provider_message_id) WHERE provider_message_id IS NOT NULL');
  pgm.sql('DROP INDEX IF EXISTS idx_jobpostings_title_trgm_sim');
};

export const down = (pgm: MigrationContext) => {
  pgm.sql('DROP INDEX IF EXISTS uq_inbound_provider_msg');
};
