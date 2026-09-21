# Intelligence domains — hackathons, colleges, and the scraper armies

How the Sales Agent platform covers **job leads + hackathon leads + college
intelligence** without merging them into one generic table, and without ever
publishing a number or a contact the data does not support.

Everything below describes code that exists in this repository. Where a
capability depends on an external service, it is marked as such.

---

## 1. Domain model (kept deliberately separate)

| Domain | Tables | UI | Ownership |
|---|---|---|---|
| Jobs (existing) | `leads`, `job_postings`, `companies`, `hr_contacts`, `enrichment_jobs` | `/leads`, `/leads/:id`, `/my-leads` (Jobs tab) | `leads.assigned_to` / `leads.claimed_by` |
| Hackathons | `hackathons`, `hackathon_occurrences`, `hackathon_contacts`, `hackathon_sources`, `hackathon_predictions` | `/hackathons`, `/hackathons/:id`, `/my-leads` (Hackathons tab) | `hackathons.claimed_by` / `assigned_to` |
| Colleges | `colleges`, `college_contacts`, `college_sources`, `college_predictions` | `/colleges`, `/colleges/:id`, `/my-leads` (Colleges tab) | `colleges.claimed_by` / `assigned_to` |
| Ops (shared) | `organizations`, `army_runs`, `scraper_sources`, `raw_discovery_records`, `scraper_errors`, `enrichment_runs`, `data_quality_results`, `prediction_runs`, `analytics_snapshots` | `/armies`, `/analytics` | — |
| Lead ops (shared, domain-scoped) | `lead_activity`, `lead_notes`, `lead_assignments`, `lead_claims` | activity/notes panels on each detail page | `domain` column isolates the timeline |

A hackathon is **never** a job lead with extra columns. Each domain has its own
table, its own filters, its own enrichment cascade and its own definition of
"outreach ready".

DDL lives in two places on purpose:

* `packages/api/database/schema/{tables,constraints,indexes}` — source of truth for a fresh install.
* `packages/api/database/migrations/013_intelligence_domains.ts` — forward-only delta for an already-deployed database.

`packages/api/test/schema_consistency.test.ts` parses both and fails if an index
targets a column that does not exist, so the two cannot drift silently.

---

## 2. Pipeline (no lead loss)

```
DISCOVER → RAW PERSIST (durable, before anything else) → NORMALIZE → DEDUPE
        → ENRICH CONTACTS → VERIFY → SCORE → PREDICT → OUTREACH READY
```

The no-lead-loss guarantee is structural, not a promise:

Durability is now enforced at the adapter level, not just the orchestrator:
`SourceAdapter.run(db_pool, run_id)` writes each discovered item to
`raw_discovery_records` **inside** the call (before returning), so even a crash
in the army orchestrator between `run()` returning and its own book-keeping
cannot lose a discovered lead. Per-source health is persisted in the same call.
Callers without a db handle (unit tests) get the records back unpersisted.

* Every discovered item is written to `raw_discovery_records` **before** parsing,
  keyed `UNIQUE (domain, source, checksum)`. A parser crash, a worker restart or
  a machine restart leaves the row in `stored` — it is re-processed later, and
  re-processing is idempotent because the checksum already exists.
* A row stuck in `processing` past the stall window is reclaimed back to
  `stored` (`reclaim_stalled_raw`), so a killed worker does not strand it.
* The raw row is only marked `processed` after the canonical upsert commits.
* `army_runs.checkpoint` + `raw_discovery_records` are the resume points; an
  interrupted run resumes rather than restarting blind.

Modules: `scrapers/domains/armies.py` (orchestration), `worker.py` per domain
(consume → normalize → enrich), `base.py` (`SourceAdapter`), `entity_resolution.py`,
`normalize.py`, `quality.py`.

---

## 3. Source-adapter contract

`scrapers/domains/base.py` defines the only thing a source must implement:

| Member | Purpose |
|---|---|
| `discover()` | yield normalized-ish raw dicts (the adapter's own parsing lives here) |
| `fetch()` | HTTP through `utils/http_client` (tiers, timeouts, UA policy) |
| `parse_item()` | static: one raw item → a domain dict, or `None` when unusable |
| `get_source_metadata()` | source name, tier, base URL, expected fields |

The base class owns everything that must not vary per source: per-source
isolation (one failure never aborts the army), bounded retry with jittered
backoff, a circuit breaker, health persisted to `scraper_sources`
(`healthy` / `degraded` / `SOURCE_TEMPORARILY_UNAVAILABLE`), and politeness
(timeouts, rate limits, robots-respecting HTTP client).

Adding a source means adding a class and registering it — never editing a
monolith. `adapter_registry()` is asserted by tests to expose both domains with
several adapters each, and `adapters_for(domain, only=[...])` lets a run target a
subset.

Sources are public pages only: official organizer/college sites, public event
platforms and APIs, government education portals, RSS/PDF of public documents.
No login walls, CAPTCHAs, paywalls or private profiles are bypassed — see
`docs/ARMY.md` for the standing exclusions.

---

## 4. Contact enrichment

The same cascade serves all three domains
(`scrapers/scrapers/domains/colleges/enrichment.py`,
`.../hackathons/worker.py`, job enrichment remains in `enrichment_worker.py`):

```
DISCOVERY → ENTITY RESOLUTION → CONTACT DISCOVERY → NORMALIZATION → VALIDATION
→ CROSS-SOURCE VERIFICATION → CONFIDENCE → PROVENANCE → STORAGE → RE-ENRICHMENT
```

Rules the code enforces:

* **No invented people.** A contact row is only written when a name/designation
  pair is found on a real page and it carries at least one locator (email, phone
  or LinkedIn) — `college_contacts_has_locator` / `hackathon_contacts_has_locator`
  CHECK constraints make this structural.
* **No guessed emails.** Addresses are never synthesised from a naming pattern;
  they are extracted and domain-checked, with platform/role addresses
  (`noreply@`, `postmaster@`, …) rejected.
* **No cross-entity copying.** A contact is attached to the entity it was found
  on; entity resolution decides which entity that is.
* **Provenance on every contact.** `contact_source`, `source_url`,
  `verification_status`, `verification_grade`, `confidence_score`, `field_provenance`.
* **Weaker never overwrites stronger.** Merges skip protected fields that are already set.
* **History is kept**: `enrichment_runs` records each attempt with per-stage status.

College contact priority (also the sort order in the UI):
`P0` TPO / placement head / placement cell → `P1` director, principal →
`P2` dean, HOD → `P3` faculty, official → `P4` other.

---

## 5. Entity resolution & deduplication

`scrapers/domains/entity_resolution.py` decides whether a discovered item is a new
canonical entity or an existing one:

| Domain | Strong signals | Fallbacks |
|---|---|---|
| College | AISHE code, official website domain, email domain | fingerprint, normalized-name key, same state + fuzzy name |
| Hackathon | canonical URL, organizer + name key + year | fingerprint, fuzzy name |
| Organization | normalized name key + org type | website domain |

`upsert_*` looks up by fingerprint, then by strong identifier, then among a
bounded candidate set of same-state rows using `same_college` / `same_hackathon`.
Existing canonical rows are *merged* (fill missing, never overwrite protected
fields). Historical occurrences are never merged away: `hackathon_occurrences`
keeps one row per year (`UNIQUE (hackathon_id, year)`) so recurrence analysis has
real history to work from.

---

## 6. Historical + predictive hackathon intelligence

`hackathons` is the canonical series; `hackathon_occurrences` is the history
(2024, 2025, 2026 …). One occurrence per edition, never overwritten.

`scrapers/domains/hackathons/prediction.py` derives a prediction only from stored
history (`analyze_recurrence`), using simple, explainable statistics — median
inter-year interval plus month consistency — and stores the evidence with it:

```
occurrence_type      once | recurring
recurrence_pattern   "every 1 year(s)" | "irregular"
predicted_occurrence median-interval next edition (only when a month is known)
confidence           10–90, sample-size based, never 100
basis                "Observed 3 occurrence(s): March 2024, March 2025, …"
evidence             [{year, month, event_start, source_url}, …]
method               historical_recurrence_analysis (month distribution + inter-year interval)
limitations          what this method cannot see
status               PREDICTED | LOW_CONFIDENCE_PREDICTION | RECURRING_PATTERN
```

Rules:

* Fewer than two dated observations → **no prediction at all** (`None`). The API
  returns `{prediction: null, available: false}`; the UI renders nothing rather
  than a placeholder date.
* Two observations may establish a *pattern* (`RECURRING_PATTERN`) but never
  publish a date; a dated `PREDICTED` needs ≥3 observations (or an unusually
  strong two-point signal) **and** confidence ≥60.
* Year-only history predicts a year and leaves the month `NULL` — no invented day.
* The CHECK constraint `hackathons_prediction_needs_basis` rejects a
  PREDICTED/LOW_CONFIDENCE row with no `prediction_basis`.
* Confirmed vs predicted is never visually identical: predicted statuses use a
  dashed amber badge (`statusBadgeClass`), the detail page leads with
  "PREDICTED — not confirmed", and the list has a `Predictions only` filter and a
  `predicted=true|false` API axis.

College "prediction" (`college_predictions`) is different by design: it forecasts
outreach windows (admission/placement season) from recorded cycles and carries the
same basis/method/limitations fields.

---

## 7. EDA / analytics

`scrapers/domains/hackathons/eda.py` and `.../colleges/eda.py` aggregate the
stored rows; `GET /hackathons/eda`, `GET /colleges/eda`,
`GET /analytics/{jobs,hackathons,colleges,scraper}` expose the same figures.

* Everything is measured: aggregates are computed over rows that exist.
* Empty input returns zeros with `measured: true` — never sample or demo figures.
* Buckets are always present (a real zero is rendered, not an ambiguous gap).
* Prize bucket edges are inclusive and disjoint (`>5L` means `> 500000`).
* The UI (`Analytics` → "Intelligence domains") shows one tab per domain with
  per-domain stat cards and ranked distributions.

---

## 8. Quality, freshness, outreach readiness

`scrapers/domains/quality.py`:

* `completeness_score(domain, record)` — weighted, and a missing value stays missing.
* `freshness_category(domain, record)` — per-domain stale windows (jobs tighter
  than colleges; upcoming hackathons expire fast around registration).
* `quality_state(...)` — one of `NEW, DISCOVERED, NORMALIZED, ENRICHING, ENRICHED,
  VERIFIED, NEEDS_REVIEW, STALE, FAILED`, persisted to `data_quality_results`.
  A reachable contact outranks the completeness heuristic: a row with a verified
  placement email is `ENRICHED` even when descriptive fields are sparse.
* `outreach_readiness` — `OUTREACH_READY`, `PARTIALLY_ENRICHED`,
  `NEEDS_ENRICHMENT`, `INSUFFICIENT_DATA`. A row with only a URL is never ready.
* Re-enrichment: rows with missing/weak contacts or stale sources are queued again
  by the sweep in the daily scheduler; priority goes to high-value, recent and
  upcoming records.

---

## 9. Scraper armies

Three independent armies, one per domain:

| Army | Domain | Sources (adapters) | Output |
|---|---|---|---|
| Job Army | `jobs` | existing India-fresher fleet | `leads` + enrichment cascade |
| Hackathon Army | `hackathons` | 18 adapters: Devpost, Unstop, MLH, Devfolio, HackerEarth, SIH, HackIndia, Reskilll, DoraHacks, Eventopia, hackathons.space, hackathon-finder, RSS feeds, curated lists (`HACKATHON_LIST_FEEDS`), **GDG events**, **company challenge pages** (`COMPANY_CHALLENGE_URLS`: GRiD/CodeVita/…), + paused pending terms review (CodeChef, Insider) | `hackathons` (+ history, contacts, predictions) |
| College Army | `colleges` | 16 adapters: AISHE, AICTE, UGC, NIRF, **NAAC**, **JoSAA/CSAB**, state portals (`COLLEGE_STATE_PORTALS`), state TPO lists (`STATE_TPO_URLS`), datasets (`COLLEGE_DATASET_URLS`), official sites, + paused directories pending terms review | `colleges` (+ contacts) |

Controls (`/armies`, admin for run; reps can read progress):

* `POST /armies/{domain}/run` → returns `run_id` immediately (202), work continues in the worker.
* `POST /armies/run-all` → queues all three; they run as separate consumers, concurrently.
* `GET /armies/runs`, `/armies/runs/:id`, `/armies/sources` → progress, per-source
  worker status, pending raw count, errors, retries, source health.

The API is a thin authenticated proxy (`src/utils/worker.ts`): the browser never
sees `WORKER_API_SECRET` and never talks to the worker directly. A worker outage
is a 502 the operator can retry, not a silent success.

Scheduling: `scrapers/scheduler.py::daily_army_scheduler` wakes at
`DAILY_ARMY_HOUR:DAILY_ARMY_MINUTE` (default **02:00 local**), claims the day once
in Redis (`SET NX`, fail-closed so a second process cannot double-run), and queues
the three armies. After queueing it also runs the existing maintenance sweeps
(unenriched, unverified, retention, freshness refresh). `ENABLE_ARMY_SCHEDULER=0`
disables it. Each army has its own queue consumer, so one army or one source
failing never cancels the others.

---

## 10. API surface (new)

```
GET    /hackathons                     list + advanced filters (state, city, organizer, month,
                                       technology, domain, mode, event type, student/public,
                                       prize range, registration, confidence, freshness,
                                       contact, ownership, predicted, q)
GET    /hackathons/search              same handler, search-first
GET    /hackathons/:id                 profile: occurrences, contacts, sources, predictions, activity, notes
GET    /hackathons/:id/history         historical occurrences (never overwritten)
GET    /hackathons/:id/prediction      {prediction, available} — absence is explicit
GET    /hackathons/:id/contacts        ranked contacts with provenance
POST   /hackathons/:id/claim|unclaim   atomic claim / release
PATCH  /hackathons/:id/assign          admin assignment (history in lead_assignments)
PATCH  /hackathons/:id/outreach        owner-only status update
POST   /hackathons/:id/notes           notes (domain-scoped)
POST   /hackathons/:id/enrich          queue organizer enrichment
GET    /hackathons/:id/activity        timeline + claim/assignment history
GET    /hackathons/eda|organizers|export

GET    /colleges                       list + filters (state, district, city, type, ownership,
                                       accreditation, enrichment, readiness, contact, ownership, q)
GET    /colleges/:id                   profile: contacts (priority-ordered), sources, quality,
                                       predictions, enrichment runs, activity, notes
GET    /colleges/states                state-wise coverage incl. TPO coverage
GET    /colleges/:id/contacts|enrichment|ownership|activity
POST   /colleges/:id/claim|unclaim|enrich|notes
PATCH  /colleges/:id/assign
GET    /colleges/eda|export

GET    /my-leads/{jobs,hackathons,colleges,summary}   only claimed OR assigned to the caller
POST   /armies/{jobs,hackathons,colleges}/run         202 + run id
POST   /armies/run-all                                202 + run ids (concurrent)
GET    /armies/runs, /armies/runs/:id, /armies/sources
GET    /analytics/{jobs,hackathons,colleges,scraper,snapshots}
GET    /search?q=&domains=                            unified search, domain-separated results
GET    /search/suggest?q=                             autocomplete for the command palette
```

Ownership is enforced per route: a lead owned by someone else is **404** for a rep
(the same answer as "does not exist"), so the pool can never be probed. Claims are
atomic (`UPDATE … WHERE claimed_by IS NULL RETURNING …`); the loser gets **409**
naming the current holder and no duplicate `lead_claims` row is written.

---

## 11. Frontend

| Route | Page | Notes |
|---|---|---|
| `/hackathons` | `pages/Hackathons.tsx` | density table, status/mode/registration/contact filters, Predictions-only toggle, CSV export, inline claim |
| `/hackathons/:id` | `pages/HackathonDetail.tsx` | prediction card (evidence, method, limitations) above the fold, organizer, eligibility, prizes, location, timeline, history, contacts with provenance, sources, verification, outreach, activity, notes |
| `/colleges` | `pages/Colleges.tsx` | state/district/type/ownership/readiness filters, coverage badges |
| `/colleges/:id` | `pages/CollegeDetail.tsx` | institution info, affiliation, placement cell, TPO/principal/director/dean/HOD contacts, programs, accreditation, sources, enrichment history, activity |
| `/my-leads` | `pages/MyLeads.tsx` | three domain tabs with their own columns and per-tab counts |
| `/armies` | `pages/Armies.tsx` | three run buttons + run-all, live run progress (polls only while something is running), per-source health |
| `/analytics` | `pages/Analytics.tsx` + `components/analytics/DomainInsights.tsx` | existing pipeline analytics plus one tab per domain |
| ⌘K palette | `components/CommandPalette.tsx` | navigation **and** record search across jobs/hackathons/colleges, results grouped per domain |

---

## 12. Testing

| Suite | Command | Covers |
|---|---|---|
| Python | `cd packages/scrapers && python3 -m pytest tests -q` | normalization, entity resolution, dedup, quality states, EDA, prediction honesty, adapter parsing (incl. NAAC/JoSAA/GDG/company-challenge), college enrichment, no-lead-loss (raw staging, idempotent dedup, stalled-row reclaim, source isolation), scheduler claim |
| API | `cd packages/api && npm test` | hackathon/college routes (RBAC, filters, claim races, prediction honesty, CSV), my-leads scoping, army proxy, analytics, search, bulk ops, pure lead-domain helpers, schema consistency |
| Web | `cd packages/web && npm test` | Hackathons list (predicted vs confirmed), Hackathon detail (prediction disclosure), My Leads tabs, Armies controls + source health, DomainInsights, command palette search |

Type safety: `npm run lint` (API, `tsc --noEmit`) and `npx tsc --noEmit` (web) are
part of the loop, not optional.

---

## 13. Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `WORKERS_URL` | API | base URL of the Python worker (default `http://workers:8000`) |
| `WORKER_API_SECRET` | API → worker | shared secret header `x-worker-key`; never exposed to the browser |
| `DAILY_ARMY_HOUR`, `DAILY_ARMY_MINUTE` | scheduler | three-army heartbeat, default `2:0` local |
| `ENABLE_ARMY_SCHEDULER` | scheduler | `0` disables the daily army heartbeat |
| `DAILY_SCRAPE_HOUR`, `DAILY_SCRAPE_MINUTE` | scheduler | legacy job-sweep schedule |
| `DATABASE_URL`, `REDIS_URL` | workers/API | durable store + queue/locks (Redis is never the only source of truth) |

---

## 14. Operational notes / limits

* **No fabrication.** Predicted rows are labelled as predictions everywhere (API
  field, badge, detail card). Missing data stays `NULL`/`NOT_VERIFIED`; the UI
  prints "Not recorded" instead of a guess.
* **Attribution and lawfulness.** Only publicly accessible pages are collected,
  with provenance recorded for every field; deletion/correction paths exist via the
  compliance routes. Rate limits, robots and platform terms are respected.
* **Known external dependencies.** Live discovery coverage depends on the
  upstream public sources being reachable; a source that is down becomes
  `SOURCE_TEMPORARILY_UNAVAILABLE` and is retried on the next run. Coverage claims
  are always the measured counts from `scraper_sources` / `army_runs`, never an
  estimate.
* **Bounded prediction accuracy.** Statistical recurrence analysis cannot foresee
  cancellations, month changes or organizer hiatuses; every prediction carries
  that limitation verbatim.
