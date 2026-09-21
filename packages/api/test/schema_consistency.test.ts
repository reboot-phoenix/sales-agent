import * as fs from 'fs';
import * as path from 'path';

/**
 * Schema consistency guard.
 *
 * The DDL lives in two places on purpose: `database/schema/*` is the source of
 * truth for a fresh install and `database/migrations/*` is the forward-only delta
 * for a database that is already deployed. They drift silently — an index written
 * against a column that does not exist only fails when the migration actually
 * runs, in production. This test parses both and checks every index target.
 */

const ROOT = path.resolve(__dirname, '..', 'database');
const SCHEMA_FILES = [
  path.join(ROOT, 'schema', 'tables', 'tables.sql'),
  path.join(ROOT, 'schema', 'indexes', 'indexes.sql'),
];

function schemaAndMigrations(): string[] {
  const migrationDir = path.join(ROOT, 'migrations');
  const migrations = fs
    .readdirSync(migrationDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(migrationDir, f));
  return [...SCHEMA_FILES, ...migrations];
}

const TABLE_CONSTRAINT_KEYWORDS = /^(constraint|primary|unique|check|foreign|exclude)\b/i;
const NON_COLUMN_TOKENS = new Set([
  'using', 'gin', 'gist', 'btree', 'hash', 'brin', 'spgist',
  'lower', 'upper', 'coalesce', 'regexp_replace', 'date_trunc', 'extract', 'now', 'trim',
  'gin_trgm_ops', 'gist_trgm_ops', 'and', 'or', 'asc', 'desc', 'nulls', 'first', 'last',
  'where', 'is', 'not', 'null', 'true', 'false', 'concurrently', 'if', 'exists', 'create',
  'unique', 'index', 'on', 'only', 'with', 'fillfactor', 'include', 'text_pattern_ops',
  'varchar_pattern_ops', 'from', 'epoch', 'day', 'month', 'year', 'interval',
]);

function columnsOf(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const tableRe = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(sql)) !== null) {
    const [, table, body] = match;
    const columns = new Set<string>();
    let depth = 0;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || depth > 0) {
        depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        continue;
      }
      if (TABLE_CONSTRAINT_KEYWORDS.test(line)) continue;
      const m = line.match(/^([a-z_][a-z0-9_]*)\s+/);
      if (m) columns.add(m[1].toLowerCase());
      depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
    }
    tables.set(table.toLowerCase(), columns);
  }
  return tables;
}

/** SQL text from a .sql file or the template literals inside a migration .ts. */
function sqlOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.sql')) return raw;
  return raw; // migration DDL lives in backtick literals; the regexes tolerate surrounding TS
}

function indexTargets(sql: string): Array<{ table: string; columns: string[] }> {
  const out: Array<{ table: string; columns: string[] }> = [];
  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+[a-z0-9_]+\s+ON\s+([a-z_][a-z0-9_]*)\s*(?:USING\s+[a-z]+)?\s*\(([^;]*?)\)\s*(WHERE[\s\S]*?)?;/gi;
  let match: RegExpExecArray | null;
  while ((match = indexRe.exec(sql)) !== null) {
    const [, table, expr] = match;
    // Split the column list on top-level commas only (function calls contain commas).
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of expr) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);

    const columns: string[] = [];
    for (const part of parts) {
      const cleaned = part
        .replace(/'[^']*'/g, ' ')          // string literals (character classes etc.)
        .replace(/\b(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, ' ');
      for (const token of cleaned.match(/[a-z_][a-z0-9_]*/gi) || []) {
        const lower = token.toLowerCase();
        if (NON_COLUMN_TOKENS.has(lower)) continue;
        if (lower.length < 2) continue;   // regexp flags / bare aliases
        columns.push(lower);
      }
    }
    out.push({ table: table.toLowerCase(), columns });
  }
  return out;
}

describe('Schema consistency', () => {
  const files = schemaAndMigrations();

  // Guards the introspection itself: if the parser silently failed, every check
  // below would pass on an empty map and prove nothing.
  test('the parser resolves real tables and columns', () => {
    const tables = columnsOf(SCHEMA_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    expect(tables.size).toBeGreaterThan(20);
    for (const [, columns] of tables) expect(columns.size).toBeGreaterThan(2);
    for (const table of ['hackathons', 'colleges', 'hackathon_occurrences', 'college_contacts',
      'army_runs', 'raw_discovery_records', 'scraper_sources']) {
      expect(tables.get(table)).toBeDefined();
      expect(tables.get(table)!.size).toBeGreaterThan(4);
    }
    expect(tables.get('hackathons')!.has('claimed_by')).toBe(true);
    expect(tables.get('colleges')!.has('aishe_code')).toBe(true);
  });

  test('every index references a table that exists and columns that are declared', () => {
    const tables = columnsOf(SCHEMA_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    expect(tables.size).toBeGreaterThan(20);

    const problems: string[] = [];
    for (const file of files) {
      const sql = sqlOf(file);
      for (const { table, columns } of indexTargets(sql)) {
        const known = tables.get(table);
        if (!known) {
          problems.push(`${path.basename(file)}: index on unknown table ${table}`);
          continue;
        }
        for (const column of columns) {
          if (!known.has(column)) {
            problems.push(`${path.basename(file)}: ${table}.${column} does not exist`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test('the hackathon/college migration and the fresh-install schema agree on tables', () => {
    const schemaSql = SCHEMA_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const schemaTables = new Set(columnsOf(schemaSql).keys());
    const migrationSql = fs
      .readFileSync(path.join(ROOT, 'migrations', '013_intelligence_domains.ts'), 'utf8');
    const migrationTables = columnsOf(migrationSql);

    for (const table of migrationTables.keys()) {
      // Every migrated table must be described by the fresh-install schema too.
      expect(schemaTables.has(table)).toBe(true);
    }
    for (const table of ['hackathons', 'colleges', 'hackathon_occurrences', 'college_contacts',
      'hackathon_predictions', 'raw_discovery_records', 'army_runs', 'scraper_sources',
      'lead_claims', 'lead_assignments', 'lead_activity', 'lead_notes', 'data_quality_results',
      'prediction_runs', 'analytics_snapshots', 'enrichment_runs', 'scraper_errors', 'organizations']) {
      expect(migrationTables.has(table)).toBe(true);
    }
  });

  test('ownership columns are per-domain so the claim race guard has a single writer', () => {
    const tables = columnsOf(SCHEMA_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    for (const table of ['hackathons', 'colleges']) {
      const columns = tables.get(table)!;
      expect(columns.has('claimed_by')).toBe(true);
      expect(columns.has('claimed_at')).toBe(true);
      expect(columns.has('assigned_to')).toBe(true);
    }
  });

  test('prediction columns cannot be populated without their basis', () => {
    const migrationSql = fs.readFileSync(
      path.join(ROOT, 'migrations', '013_intelligence_domains.ts'), 'utf8');
    // The check constraint is what makes "no prediction without evidence" structural.
    expect(migrationSql).toContain('hackathons_prediction_needs_basis');
    expect(migrationSql).toMatch(/status NOT IN \('PREDICTED','LOW_CONFIDENCE_PREDICTION'\)/);
    expect(migrationSql).toContain('hackathon_predictions_has_evidence');
  });
});
