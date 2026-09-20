# [Sales Agent Production Hardening] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the already-built HireGen Sales Agent to production-ready: Cloudflare-safe frontend, VM-ready backend, 1–10 scoring + freshness, confirmed + live Run Army, no fake UI.

**Architecture:** Non-breaking presentation-layer additions (computed SQL columns, score_10 mapping, freshness utils) + nginx security headers + confirmation UX. No DB migration, no scoring-engine rescale (0–100 stays canonical internally; 1–10 is the product scale).

**Tech Stack:** Fastify API, React+Vite+nginx web, Python FastAPI workers, Postgres 16, Redis 7.

**Spec:** User master prompt 2026-09-20 (45 sections in conversation).

## Global Constraints

- Never commit secrets; env-only config.
- No duplicate pages/components/APIs/services/models/workers/queues — fix, don't rebuild.
- No `Access-Control-Allow-Origin: *` for authenticated APIs.
- No fake progress; UI reflects backend state only.
- No localhost assumptions in production config.
- YAGNI, stdlib-first, smallest working diff.

## Review Focus

- CSP breaking Vite hashed assets or SSE (`/sse`) stream — expect app to load + stream with headers on.
- Freshness "Unknown" must show when both posted_at and created_at are null/invalid — expect text label, not color-only.
- score_10 mapping boundaries (0→1, 100→10) — expect monotonic 1–10.
- Run Army double-click must not fire twice — expect button disabled + loading while pending.
- nginx `add_header` inheritance (location blocks drop parent headers) — expect headers repeated per location.

---

### Task 1: Nginx security headers + CSP (Cloudflare-compatible)

**Files:**
- Modify: `packages/web/nginx.conf`
- Create: `packages/web/public/_headers`
- Create: `docs/cloudflare.md`

**Interfaces:**
- Consumes: existing nginx locations (`/`, `/index.html`, `/assets/`, `/api`, `/sse`, `/ws`).
- Produces: headers present on every response; documented Cloudflare settings.

- [ ] **Step 1: Add headers + CSP to nginx.conf**

Prepend (after `server_name` is fine, but headers must be repeated inside each `location` because nginx `add_header` does not inherit once a location adds its own — so define once at server level AND repeat Cache-Control locations):

```nginx
# Security headers (Cloudflare passes these through; also correct standalone).
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
# HSTS only when served over TLS (Cloudflare terminates TLS in front).
# Enable on the TLS terminator; kept commented for plain-HTTP local dev:
# add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
# Minimal CSP for this SPA: self + same-origin API/SSE/WS; images allow data: + https:;
# style-src needs 'unsafe-inline' (Tailwind runtime + Vite); script-src has NO unsafe-eval.
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" always;
```

Also repeat the security `add_header` lines inside `location = /index.html` and `location /assets/` alongside their Cache-Control (else they lose the headers).

- [ ] **Step 2: Create `packages/web/public/_headers` (Cloudflare Pages / static-host compat)**

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Frame-Options: SAMEORIGIN
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache, no-store, must-revalidate
```

- [ ] **Step 3: Create `docs/cloudflare.md`** (origin = nginx web container; Cloudflare: Full(strict) TLS, no APO/cache on `/api/*` `/sse/*` `/ws/*`, cache `/assets/*`, SPA fallback via nginx `try_files` — no extra rule needed).

- [ ] **Step 4: Verify**

Run: `docker compose config` (valid yaml) + `nginx -t` if available, else `vite build` for web. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/nginx.conf packages/web/public/_headers docs/cloudflare.md
git commit -m "feat(web): production security headers + minimal CSP + Cloudflare docs"
```

### Task 2: 1–10 score scale + freshness tagging (non-breaking)

**Files:**
- Modify: `packages/api/src/utils/scoring.ts`
- Modify: `packages/api/src/utils/leadColumns.ts`
- Modify: `packages/api/src/routes/leads.ts` (score endpoint only)
- Create: `packages/web/src/lib/freshness.ts`
- Modify: `packages/web/src/lib/format.ts` (score_10 display helper)
- Modify: `packages/web/src/pages/Leads.tsx` (score cell + freshness badge + filter)

**Interfaces:**
- Consumes: `lead_score` 0–100, `posted_at`, `created_at`.
- Produces: `score_10` 1–10, `freshness_category` fresh|recent|older|unknown + `freshness_label`.

- [ ] **Step 1: Add pure helpers to scoring.ts**

```ts
export function toScore10(score100: number): number {
  const s = Math.max(0, Math.min(100, Math.round(score100)));
  return Math.max(1, Math.min(10, Math.round(s / 10) || 1));
  // 0→1, 1-5→1, 95-100→10
}
export type FreshnessCategory = 'fresh' | 'recent' | 'older' | 'unknown';
export function freshnessCategory(postedAt?: string | null, discoveredAt?: string | null): FreshnessCategory {
  const ref = postedAt || discoveredAt;
  if (!ref) return 'unknown';
  const t = new Date(ref).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'fresh'; // future clock skew → treat as fresh, never crash
  if (ageMs < 24 * 3600 * 1000) return 'fresh';
  if (ageMs < 7 * 24 * 3600 * 1000) return 'recent';
  return 'older';
}
```

- [ ] **Step 2: Extend LEAD_SELECT_SQL with computed columns (no migration)**

```sql
l.created_at, l.updated_at,
-- Product scale 1-10 derived from canonical 0-100 (no rescale migration).
GREATEST(1, LEAST(10, ROUND(l.lead_score / 10.0))) AS score_10,
-- Freshness prefers source posted_at, falls back to discovery time; unknown when neither.
CASE
  WHEN COALESCE(jp.posted_at, l.created_at) IS NULL THEN 'unknown'
  WHEN COALESCE(jp.posted_at, l.created_at) > NOW() - INTERVAL '24 hours' THEN 'fresh'
  WHEN COALESCE(jp.posted_at, l.created_at) > NOW() - INTERVAL '7 days' THEN 'recent'
  ELSE 'older'
END AS freshness_category,
```

- [ ] **Step 3: Score endpoint returns both scales**

In `GET /:id/score`, return `{ ...explained, score_10: toScore10(explained.score) }`.

- [ ] **Step 4: Frontend `freshness.ts` + format helper**

```ts
export type FreshnessCategory = 'fresh' | 'recent' | 'older' | 'unknown';
export const FRESHNESS_META = {
  fresh: { tag: '<24H', label: '<24 hrs', className: 'bg-destructive-soft text-destructive border-destructive/20' },
  recent: { tag: '<7D', label: '<7 days', className: 'bg-success-soft text-success border-success/20' },
  older: { tag: 'OLDER', label: 'Older', className: 'bg-warning-soft text-warning border-warning/20' },
  unknown: { tag: 'UNKNOWN', label: 'Unknown', className: 'bg-muted text-muted-foreground border-border' },
} as const;
export function freshnessCategory(postedAt, discoveredAt): FreshnessCategory { ...same logic... }
export function freshnessLabel(postedAt, discoveredAt): string {
  // "3h ago", "4d ago", "12d ago", "Unknown" — text tags only.
}
export function score10(score100: number): number { ...same mapping... }
```

- [ ] **Step 5: Leads UI — score cell shows `9/10` + band, freshness badge column, freshness filter `<select>` (All/Fresh <24h/Recent <7d/Older/Unknown) wired to client filter (server already returns category).**

- [ ] **Step 6: Verify**

Run: `cd packages/api && npm test` (scoring tests still pass), `cd packages/web && npm test`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/utils/scoring.ts packages/api/src/utils/leadColumns.ts packages/api/src/routes/leads.ts packages/web/src/lib/freshness.ts packages/web/src/lib/format.ts packages/web/src/pages/Leads.tsx
git commit -m "feat(leads): 1-10 score scale + freshness tagging with unknown state"
```

### Task 3: Run Army confirmation + idempotent trigger

**Files:**
- Modify: `packages/web/src/pages/Dashboard.tsx`
- Modify: `packages/web/src/pages/Leads.tsx`

**Interfaces:**
- Consumes: existing `ConfirmDialog`, `admin.runArmy()`, `armyStatus` queue counts.
- Produces: every army trigger gated by confirmation showing sources/records/cost + disabled-while-pending.

- [ ] **Step 1: Dashboard — add `armyConfirmOpen` state; hero button opens dialog instead of mutate; dialog text:**

Title: `Run Data Collection Army?` Description: `Sources to run: all configured (${queued} leads currently in flight). Enrichment + OSINT + paid providers fire where keys exist and may consume credits. This starts a long-running background job — safe to leave the page; progress streams live below.` Confirm: `Run Army`. `onConfirm` → `armyMutation.mutate()` + close. Pass `loading={armyMutation.isLoading}` and `disabled` while loading (Button already supports loading → ensure `disabled={armyMutation.isLoading}` too for double-click safety).

- [ ] **Step 2: Leads — same dialog for header button + empty-state button.**

- [ ] **Step 3: Verify** `cd packages/web && npm test` + manual click-through. Expected: PASS, dialog appears, double-click fires once.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/pages/Dashboard.tsx packages/web/src/pages/Leads.tsx
git commit -m "feat(army): confirm-before-run with live queue counts, idempotent trigger"
```

### Task 4: IP privacy hashing + VM/CORS docs

**Files:**
- Modify: `packages/api/src/utils/redact.ts` (add `hashIp`)
- Create: `docs/vm-deploy.md` (append CORS + env + Cloudflare origin sections if file exists — check first, do not duplicate)

**Interfaces:**
- Consumes: `ENCRYPTION_SECRET` or dedicated `IP_HASH_SECRET` (documented; falls back gracefully).
- Produces: `hashIp(ip, secret)` HMAC-SHA256, never reversible, never logged raw.

```ts
import crypto from 'crypto';
export function hashIp(ip: string | null | undefined, secret: string): string {
  if (!ip) return 'unknown';
  return 'ip_' + crypto.createHmac('sha256', secret).update(String(ip).trim().toLowerCase()).digest('hex').slice(0, 32);
}
```

Document: rate-limit uses in-memory `req.ip` only; `audit_log` stores no IPs; if IP logging is ever added, store `hashIp` output with 90-day retention, secret server-side only.

- [ ] **Step 1: Implement + unit test in existing api test suite style.**
- [ ] **Step 2: Docs.**
- [ ] **Step 3: Verify** `cd packages/api && npm test`.
- [ ] **Step 4: Commit.**

### Task 5: Final verification loop

- [ ] **Step 1:** `cd packages/api && npm run lint && npm test`
- [ ] **Step 2:** `cd packages/web && npm test && npm run build`
- [ ] **Step 3:** `cd packages/scrapers && python -m pytest tests/ -x -q`
- [ ] **Step 4:** `docker compose config` valid; boot stack if docker available and curl `/health`, `/api/health` (document results, do not fake).
- [ ] **Step 5:** Responsive spot-check at 390/768/1280 for Leads + Dashboard (note any overflow found, fix or file).
