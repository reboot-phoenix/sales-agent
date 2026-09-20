# Backend VM deployment

The stack is split: Cloudflare → `web` (nginx static) → `api` (Fastify :3000)
→ Postgres / Redis / workers. Frontend and backend are different origins in
prod — no localhost assumptions.

## Required env (VM)

```
DATABASE_URL=postgresql://postgres:<pw>@postgres:5432/leads_db
REDIS_URL=redis://redis:6379
JWT_SECRET=<64+ random chars, NOT the .env.example placeholder>
ENCRYPTION_SECRET=<32+ chars, encrypts Settings API keys at rest>
CORS_ORIGIN=https://app.yourdomain.example        # exact frontend origin(s), comma-separated
TRUST_PROXY=true                                   # nginx is the trusted proxy hop
COOKIE_SECURE=true                                 # served over TLS
WORKERS_URL=http://workers:8000
WORKER_API_SECRET=<shared secret, api → workers>
METRICS_TOKEN=<Bearer token for /metrics; unset = 503 fail-closed>
PORT=3000
NODE_ENV=production
```

Optional: `GEMINI_API_KEY` (drafts), `RESEND_API_KEY`/`BREVO_API_KEY`
(sending), `SNOVIO_*`/`CONTACT_OUT_API_KEY` (global enrichment fallback —
per-user Settings keys take precedence), Adzuna/Jooble keys.

## Process separation

`docker-compose.yml` already separates `api`, `workers` (scrapers +
enrichment + verification + drafts + scheduler consumers), `reacher`,
`postgres`, `redis`, `n8n`. Each restarts independently
(`restart: unless-stopped`); queues are Redis-AOF persisted with
`:processing`-claim + boot reclaim, so a worker crash re-queues instead of
losing jobs. Never run two writers on the same queue set.

## Health / recovery checks

- `GET /health` (api) and `:8000/health` (workers) — load-balancer probes.
- `GET /api/integrity` (admin) — stuck leads + queue depths.
- `GET /metrics` — Bearer `METRICS_TOKEN` only; aggregates, no PII.
- Schema: `packages/api/database/schema/` is the fresh-install source of truth
  (idempotent); `database/migrations/` are forward-only deltas for deployed DBs.

## Privacy notes

- Rate limiting uses in-memory `req.ip` only; `audit_log` stores no IPs.
- If IP evidence is ever needed, store `hashIp(ip, secret)` (HMAC-SHA256,
  `ip_<32hex>`), never raw IPs; secret server-side only; 90-day retention.
- Logs redact `authorization` headers; metrics emit aggregates only
  (no emails, names, lead ids).
