/**
 * Dependency-aware health checks (master-prompt §39).
 *
 * The original /health answered `{status:'ok'}` unconditionally — a probe target
 * that reports healthy while it cannot reach Postgres routes traffic to a pod
 * that cannot serve it. These helpers report each dependency separately and
 * compute an aggregate:
 *
 *   /liveness  — is the process itself up? (cheap, no dependencies: a process
 *                that cannot reach Postgres must NOT be restarted, it must be
 *                removed from rotation; restarting a database-less pod fixes
 *                nothing and hammers the DB with reconnect storms)
 *   /readiness — can this instance serve traffic? (checks DB + Redis)
 *   /health    — human/dashboard aggregate with per-dependency detail
 */
import { getDB } from './db';
import { getRedis } from './redis';

export interface DependencyCheck {
  status: 'ok' | 'down';
  /** Wall-clock latency of the probe in ms (undefined when the check failed). */
  latency_ms?: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    database: DependencyCheck;
    redis: DependencyCheck;
  };
  timestamp: string;
  uptime_seconds: number;
}

async function checkDb(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await getDB()`SELECT 1`;
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function checkRedis(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await getRedis().ping();
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/** Full report — used by /health and /readiness. Never throws: a dependency
 * being down is a reportable state, not an exception. */
export async function fullHealthReport(): Promise<HealthReport> {
  const [database, redis] = await Promise.all([checkDb(), checkRedis()]);
  const allOk = database.status === 'ok' && redis.status === 'ok';
  return {
    status: allOk ? 'ok' : 'down',
    checks: { database, redis },
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  };
}

/** Liveness probe — deliberately dependency-free so orchestrators never restart
 * a healthy process just because a downstream database blipped. */
export async function livenessReport(): Promise<{ status: 'ok'; timestamp: string; uptime_seconds: number }> {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  };
}
