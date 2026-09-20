# HireGen — Lead Intelligence Engine

Full-stack lead generation & outreach system: scrape job postings → enrich leads → verify emails → AI-draft outreach → send. Runs **entirely with one command**.

| Your OS | Run this |
|---|---|
| **Linux / macOS** | `./up.sh` |
| **Windows 10/11** (PowerShell) | `powershell -ExecutionPolicy Bypass -File .\up.ps1` |

Both do the same thing:
1. Builds all Docker images (API, Web, Workers)
2. Starts the full stack (Postgres, Redis, API, Web, Workers, Reacher, n8n)
3. Applies the database schema and migrations (idempotent — safe on every run)
4. Bootstraps the admin login from `.env` (see [Login](#login))

`up.sh` additionally starts the host SSH server on port 22 — that step is Linux host ops and is deliberately absent from `up.ps1`, where it has no meaning under Docker Desktop.

---

## Login

The launcher creates an admin account from these two `.env` values (idempotent — it no-ops if an admin already exists):

```ini
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMe!Admin2026
```

Sign in at **http://localhost:5173** with that email and password.

> ⚠️ **Change both before any non-local deployment.** They are development defaults committed in `.env.example`; anyone who reads this repo knows them.

**Do not use "Register" to get in.** Self-registration always creates a `sales_rep`, and RBAC restricts a rep to leads assigned to them — on a fresh clone that means an empty Leads page even though scraping produced hundreds. Use the admin account above; create rep accounts from **Settings → Users** once you want scoped access.

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| Docker Engine 24+ / Docker Desktop | Runs everything | `docker --version` |
| Docker Compose v2 | Orchestrates the stack | `docker compose version` |
| WSL2 backend enabled (Windows) | Required for Docker Desktop to run Linux containers | Docker Desktop → Settings → Resources |
| `sudo` access (**Linux/macOS only**) | Starting SSH service (prompts once, only if port 22 is down) | — |

No Node, Python, or Postgres install needed — everything runs in containers.

---

## Quick Start

### Linux / macOS

```bash
# 1. Get the code
git clone https://github.com/rajat-wyrm/sales-agent.git
cd sales-agent

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   JWT_SECRET         (any long random string)
#   ENCRYPTION_SECRET  (min 32 chars — encrypts API keys at rest)
#   ADMIN_EMAIL / ADMIN_PASSWORD (the login above)
# Optional but recommended: GEMINI_API_KEY, RESEND_API_KEY

# 3. Start EVERYTHING
./up.sh
```

### Windows 10 / 11

Open **PowerShell** in the repo folder:

```powershell
# 1. Get the code
git clone https://github.com/rajat-wyrm/sales-agent.git
cd sales-agent

# 2. Configure environment (notepad opens the file; saving is enough)
Copy-Item .env.example .env
notepad .env
#    Set JWT_SECRET, ENCRYPTION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD as above

# 3. Start EVERYTHING
powershell -ExecutionPolicy Bypass -File .\up.ps1
```

If you see *"running scripts is disabled on this system"*, use the `-ExecutionPolicy Bypass` form above (it applies to this one invocation only and does not change your system policy).

Both launchers auto-create `.env` from `.env.example` if it is missing, then print a reminder to edit it.

Then open **http://localhost:5173** and sign in with the [admin credentials](#login).

> **Heads-up:** the first run pulls base images and builds — takes a few minutes. Subsequent runs are fast (cached layers).

---

## Services & Ports

| Service | URL | What it is |
|---|---|---|
| **Web CRM** | http://localhost:5173 | React 18 + Vite + Tailwind — the main UI (nginx serves it, proxies `/api` and `/ws` to the API) |
| **API** | http://localhost:3000 | Fastify (Node 20) — auth, leads, companies, contacts, dashboard, webhooks |
| **API docs (health)** | http://localhost:3000/health | Health check |
| **Workers** | http://localhost:8000/health | FastAPI (Python 3.12) — scraper fleet, enrichment, verification, AI drafts |
| **n8n** | http://localhost:5678 | Workflow orchestration (login: user from `.env`, default `admin` / `change-this-password`) |
| **Reacher** | http://localhost:5050 | Self-hosted email verification |
| **PostgreSQL 16** | localhost:5432 | Database `leads_db` (app) + `n8n` (orchestrator, kept separate to avoid schema clashes) |
| **Redis 7** | localhost:6379 | Queues & cache |
| **SSH** | port 22 | Remote access to the host (password auth = your system password) |

Default DB credentials (local dev only): `postgres` / `postgres`.

---

## The Pipeline (SRS §9)

```
Step 1  Scrape       Scraper fleet (Lever, Greenhouse, Adzuna, Arbeitnow, GitHub internship lists…)
                     → raw leads → Postgres              [n8n cron or manual trigger]

Step 2  Enrich       OSINT enrichment (Snov.io, ContactOut — bring your own keys in Settings)
                     → company + HR contact data         [per-row button in UI]

Step 3  Verify       Email/WhatsApp verification (Reacher self-hosted)
                     → verification_log                  [per-row button in UI]

Step 4  Draft        Gemini AI outreach draft generation
                     → outreach_drafts                   [per-row button in UI]

Step 5  Send         Resend / Brevo email or WhatsApp
                     → outreach_log + webhooks           [per-row button in UI]
```

Steps 2–5 are **on-demand per lead** from the CRM — click a lead, run the step, see the result.

### CRM Pages
**Dashboard** (stats) · **Leads** (filter/score/pipeline) · **Lead Detail** (full record + actions) · **Companies** · **Contacts** · **Duplicates** · **Analytics** · **Settings** (store your Snov.io / ContactOut / Resend keys — encrypted at rest with AES-256-GCM)

---

## Configuration (`.env`)

Copy `.env.example` → `.env`. Key variables:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | Long random string — signs auth tokens |
| `ENCRYPTION_SECRET` | ✅ | Min 32 chars — encrypts API keys stored in Settings |
| `GEMINI_API_KEY` | for AI drafts | Gemini 2.5 Flash, free tier available |
| `RESEND_API_KEY` / `BREVO_API_KEY` | for sending | Resend 3K/mo or Brevo 300/day free tier |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | for that scraper | Free registration |
| `SNOVIO_API_KEY` / `CONTACT_OUT_API_KEY` | for enrichment | Can also be set in the Settings page instead |
| `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` | n8n login | **Change the default** |
| `WHATSAPP_WEB_URL` | WhatsApp send | Self-hosted whatsapp-web.js instance |

All other variables have sensible defaults for local Docker use. **Never commit `.env`.**

---

## What happens automatically once you paste API keys

Keys can be set in the **Settings page** (encrypted at rest) or via `.env`.
Settings values take precedence. **No restart is needed** — workers read keys from
the database on every job, so a key pasted mid-run applies to the next job.

The pipeline is chained: each stage queues the next one automatically.

```
daily scrape (03:00 UTC) → normalise → enrich → verify → draft      [automatic]
                                                        ↓
                                                     send           [manual, always]
```

| Key you paste | What starts working, unprompted |
|---|---|
| `Gemini` | Drafts become AI-written and personalised per lead instead of falling back to the generic template. Applies to drafts generated from then on. |
| `Snov.io` | Enrichment tries Snov.io first for an HR email before the free OSINT cascade. Costs credits per lookup. Needs the Email Finder entitlement on the account. |
| `Resend` (`re_…`) or `Brevo` (`keysib-…`) | Sending works when you click Send / bulk Send. Nothing mails itself — see below. |
| `Adzuna` (`ADZUNA_APP_ID`/`KEY`), `Jooble` | Those two scrapers return real results on the next scheduled run instead of being skipped as unconfigured. |
| `Reddit` (`REDDIT_CLIENT_ID`/`SECRET`) | Reddit job-postings scraping starts contributing leads on the next run (uses `praw`). |
| `Telegram` (`TELEGRAM_API_ID`/`HASH`) | Needs the `telethon` package added to `requirements.txt`; it is not installed in the worker image today, so enabling this source is a code change plus keys. Not in the daily default rotation. |
| `Twitter` | **Cannot work.** The scraper uses `snscrape`, which is not installed and has been non-functional since X closed unauthenticated reading in 2023. Opt-in only, so it costs nothing, but pasting a key here does nothing. Consider removing the field. |
| `ContactOut` | **Nothing yet.** ContactOut publishes no public REST API — its documented host answers 404 with an HTML page and the alternate hostname does not resolve. If you are issued a real endpoint, set `CONTACTOUT_API_URL` and it will be used. |
| `WhatsApp session` | **Nothing yet.** Requires a whatsapp-web.js microservice that is not part of this stack; until it exists, WhatsApp actions return "blocked / whatsapp_not_configured" rather than pretending to send. |

**Sending is never automatic, by design.** No credential turns on auto-send; a human
clicks Send or bulk Send. This keeps a bad key or a scoring mistake from mailing
hundreds of recruiters unattended.

Verification nuance: an SMTP failure caused by *our* egress or sender reputation
(Google's `5.2.1` reply to datacenter IPs) records `unknown`, not `invalid`, so a
deliverable address is never silently discarded. Only an explicit recipient rejection
(`5.1.1`, "user unknown", "no such user") marks an email invalid.

---

## Daily Operations

```bash
./up.sh                          # start everything (idempotent — safe to re-run anytime)
docker compose ps                # see status
docker compose logs -f api       # tail API logs (also: web, workers, n8n, postgres, redis)
docker compose restart api       # restart one service
docker compose down              # stop (data volumes kept)
docker compose down -v           # stop AND wipe databases ⚠️
```

On Windows the commands are identical except the launcher:

```powershell
.\up.ps1                         # start everything (idempotent — safe to re-run anytime)
docker compose ps
docker compose logs -f api
# PowerShell equivalent of `| head` is `| Select-Object -First 20`
```

Full rebuild after code changes:
```bash
docker compose up -d --build
```

### Triggering a scrape manually
```bash
curl -X POST http://localhost:8000/scrape/trigger \
  -H 'Content-Type: application/json' -d '{}'
```
Or let n8n run it on a cron schedule.

### Database
```bash
docker compose exec postgres psql -U postgres -d leads_db   # interactive SQL
```
Schema is auto-applied on every `./up.sh` from `packages/api/database/schema/` (idempotent, `IF NOT EXISTS`), one file per concern: `schema/tables/tables.sql`, `schema/constraints/constraints.sql`, `schema/functions/functions.sql`, `schema/triggers/triggers.sql`, `schema/indexes/indexes.sql` (applied in that dependency order by `database/utils/apply_schema.sh`). **That folder is the source of truth** — add new tables/columns/indexes/constraints to the matching file there. For an already-deployed prod DB, forward-only deltas go in `database/migrations/` (run via `npm run migrate`).

---

## SSH Access (Linux host only)

`./up.sh` ensures the SSH server is listening on port 22. `up.ps1` does not touch SSH — on Windows this stack runs inside Docker Desktop and there is no host SSH service to manage.

```bash
ssh rajat@<host-ip>        # from another machine on your network
```
- Password auth uses your **system login password**
- For key-based auth, add your public key to `~/.ssh/authorized_keys`
- Find your IP: `ip -4 addr show wlo1 | grep inet`

---

## Architecture

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│  Web (nginx)│────▶│ API Fastify │────▶│ Postgres 16│
│  :5173      │ /api │  :3000      │     │  :5432     │
└────────────┘ /ws  └─────┬──────┘     └────────────┘
                          │ ┌────────────┐
                          ├▶│ Redis 7    │
                          │ │  :6379     │
                          │ └────────────┘
┌────────────┐           │
│ n8n :5678  │──cron────▶┌────────────────┐    ┌──────────┐
└────────────┘           │ Workers FastAPI │───▶│ Reacher  │
   (own n8n DB)          │  :8000         │    │  :5050   │
                         └────────────────┘    └──────────┘
```

### Repo Layout
```
up.sh                     ← one command, Linux/macOS
up.ps1                    ← same thing, Windows PowerShell
docker-compose.yml        ← full stack definition
.env / .env.example       ← configuration
packages/
  api/                    ← Fastify API — src/routes: auth, leads, companies,
                            contacts, dashboard, admin, webhooks, ws
    database/
      schema/             ← tables, constraints, functions, triggers, indexes
                            (source of truth for a FRESH install)
      migrations/         ← forward-only deltas for an ALREADY-DEPLOYED db
      seeds/ config/ utils/
  web/                    ← React CRM — src/pages, components, hooks, stores, lib
  scrapers/               ← Python fleet — scrapers/*.py per source,
                            scrapers/utils/ shared logic, scrapers/spiders/ scrapy,
                            main.py = FastAPI + consumer supervisor
docs/                     ← SRS.md, PROGRESS.md, MASTER_PROMPT.md, compliance gate,
                            traceability matrix, per-track design specs (superpowers/)
.github/workflows/ci.yml  ← CI: typecheck + tests for all three packages, then
                            image build & push to ghcr.io
```

Note: n8n runs from the official `n8nio/n8n` image with its own Postgres DB and
needs no files in this repo — the empty `packages/n8n/` placeholder was removed.

### Data Flow
Scrapers write raw leads to Postgres via Redis queues → CRM shows them with a computed `lead_score` / `score_band` (hot ≥70, warm ≥40, cold <40) → per-lead enrichment/verification/drafting → outreach with full logging + webhook delivery events.

---

## Development (without Docker)

```bash
# Terminal 1 — infra only
docker compose up -d postgres redis reacher

# Terminal 2 — API (hot reload)
cd packages/api && npm install && npm run dev

# Terminal 3 — Web (Vite dev server, proxies /api → :3000)
cd packages/web && npm install && npm run dev

# Terminal 4 — Workers
cd packages/scrapers && pip install -r requirements.txt && uvicorn main:app --reload
```

### Tests
```bash
cd packages/web && npm test           # jest (Leads, Login, Duplicates)
cd packages/api && npm test         # jest
cd packages/api && npm run lint     # tsc typecheck
cd packages/scrapers && python -m pytest tests/   # scrapers, workers, circuit breaker, robots checker
```
CI (`.github/workflows/ci.yml`) runs these plus Docker image builds (pushed to `ghcr.io`) on every push.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `./up.sh` asks for sudo password | Normal — it needs root to start SSH. Enter your password once. |
| Port already in use (`5432`/`3000`/`5173`…) | A local service conflicts: `docker compose down && sudo systemctl stop postgresql` (or whichever), re-run. |
| `leads` table missing / API 500 on `/api/leads` | `docker compose up -d pg-migrator` — or just re-run `./up.sh` (schema is idempotent). |
| Web loads but login fails | Register first (`/register` in the UI) — there is no seeded default user. |
| n8n login rejected | Credentials come from `N8N_BASIC_AUTH_USER`/`PASSWORD` in `.env`, and `.env` changes need `docker compose up -d n8n`. |
| Gemini drafts fail | `GEMINI_API_KEY` missing/invalid — set it in `.env`, then `docker compose up -d workers api`. |
| Image build stale after editing code | `docker compose up -d --build` (plain `up -d` reuses cached images). |
| Everything is weird | `docker compose down -v && ./up.sh` — nukes and rebuilds from scratch. |

---

## Security Notes

- `.env` holds secrets — it's gitignored; never commit it
- **`ADMIN_EMAIL` / `ADMIN_PASSWORD` ship as known defaults** (see [Login](#login)). Change them before anything leaves your machine.
- API keys entered in **Settings** are encrypted at rest (AES-256-GCM via `ENCRYPTION_SECRET`)
- Change `N8N_BASIC_AUTH_PASSWORD` and both secrets before any real use
- Postgres/Redis ports are exposed for local dev only — don't do that in prod
- `/api/metrics`, `/api/integrity` and all DLQ routes are admin-gated; metrics emit aggregates only (no emails, names or lead ids)

---

## Status

**Phase 0 complete** (revalidation + pipeline skeleton, see `docs/PROGRESS.md`), and the six-program follow-on is **implemented, tested and verified end to end**. Built per `docs/SRS.md`; compliance details in `docs/SRS_COMPLIANCE_GATE.md`, per-track design records in `docs/superpowers/specs/`.

| Track | Delivered |
|---|---|
| 1 Durability | Redis AOF (`everysec`) on a named volume; crash-safe queues — jobs move to `:processing` on pop and are acked only after DB commit, with boot reclaim of stranded work |
| 2 Sources | 50 sources wired, 33 in the daily default rotation — India-first (Naukri, Internshala, Freshersworld, Apna, Workindia, Shine, TimesJobs, Foundit, InstaHyre, CutShort, Unstop, IIMJobs, JobInsider, Hirist, ClassicJobs, HackerEarth, AmbitionBox, OffCampus, HasJob, FreshersVoice via off-campus flow, HackerNews Who's Hiring, RippleHire discovery) plus global ATS/API coverage (Greenhouse, Lever, Workday, Ashby, SmartRecruiters, BambooHR, Personio, Recruitee, Teamtailor, Breezy, RemoteOK, Arbeitnow, Adzuna, Jooble, Wellfound, Glassdoor, DuckDuckGo/Google dorks, Amazon, LinkedIn/Twitter/Telegram surfaces). ATS board hosts can no longer leak into employer-domain lookups |
| 3 Reliability | `parser_version` + `content_hash` snapshotting, `GET /api/integrity` (stuck leads + queue depths), audited DLQ inspect/redrive/purge |
| 4 Search | Trigram GIN on `hr_contacts(full_name, personal_email)`; planner usage proven by test |
| 5 Observability | Dependency-free Prometheus exposition at `GET /api/metrics` |
| 6 Resilience | Stale-token rejection with one 401 contract, client refresh-and-retry, offline banner, unsent drafts backed up to localStorage |

**Verification:** api `tsc` clean + jest 96/96 · web `tsc` clean + jest 17/17 + vite build ok · scrapers pytest 307/307 · migrations idempotent on re-run · live browser check of login, auth recovery, dashboard counts and draft-backup round-trip.

**Still requires user-supplied keys** (queues and UI work without them; calls are skipped): Gemini drafts, Resend/Brevo sending, Snov.io / ContactOut enrichment, WhatsApp pairing.
