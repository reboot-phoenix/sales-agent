/**
 * Idempotent admin bootstrap.
 *
 * The app seeds no first user, so on a fresh install every account is a
 * `sales_rep` that RBAC filters to "assigned leads only" → the Leads page shows
 * nothing. This creates a single `admin` (sees all leads, manages API keys) from
 * ADMIN_EMAIL / ADMIN_PASSWORD, and no-ops if an admin already exists or the env
 * vars aren't set. Safe to run on every `up`.
 */
import { getDB, closeDB } from '../utils/db';
import { hashPassword } from '../utils/crypto';

async function main() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = (process.env.ADMIN_PASSWORD || '').trim();
  if (!email || !password) {
    console.info('ℹ️  ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin bootstrap.');
    return;
  }
  if (password.length < 8) {
    console.error('❌ ADMIN_PASSWORD must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }
  const sql = getDB();
  // SAFE bootstrap keyed on email, never on role: the old shortcut
  // (`SELECT ... WHERE role='admin' LIMIT 1`) skipped promotion when ANY admin
  // existed (wrong email) and the ON CONFLICT DO UPDATE overwrote the
  // password_hash of an existing sales_rep row with ADMIN_EMAIL, locking out
  // its owner. Now: row exists + role=admin -> no-op; row exists + other role
  // -> promote role ONLY, preserving password_hash; no row -> INSERT new admin.
  const existing = await sql`SELECT id, role FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length > 0) {
    if ((existing[0] as { role: string }).role === 'admin') {
      console.info('ℹ️  Bootstrap admin already exists — skipping.');
      return;
    }
    await sql`UPDATE users SET role = 'admin' WHERE email = ${email}`;
    console.info(`✅ Promoted existing user to admin: ${email} (password unchanged)`);
    return;
  }
  const hash = await hashPassword(password);
  await sql`
    INSERT INTO users (email, password_hash, role, api_keys)
    VALUES (${email}, ${hash}, 'admin', '{}')
    ON CONFLICT (email) DO NOTHING`;
  console.info(`✅ Bootstrap admin ready: ${email}`);
}

main()
  .catch((e) => { console.error('❌ admin bootstrap failed:', e); process.exitCode = 1; })
  .finally(() => { void closeDB(); });
