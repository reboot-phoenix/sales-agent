"""
Queue consumer for scrape_queue:requests.

Consumes scrape jobs dispatched by n8n/API, runs the requested scrapers,
and pushes results to raw_leads_queue for normalization.

Per SRS §4.1: n8n cron daily at 02:00 IST triggers this consumer via webhook.
Per SRS §4.6: scrapers push raw records to raw_leads_queue.
"""

import json
import uuid
import os
import asyncio
import logging
from typing import Any

import redis.asyncio as redis

from .queue import requeue_or_dlq, reliable_brpop, ack

logger = logging.getLogger(__name__)

# Cooperative army halt. POST /army/stop sets this key (TTL-bounded so a stop
# can never wedge future scheduled runs); the consumer checks it before each
# job and every few seconds mid-run, cancelling in-flight sources promptly.
HALT_KEY = "army:halt"
HALT_TTL_SECONDS = 600


async def halt_requested(redis_client) -> bool:
    """True when an operator stopped the army. Fail-closed False: a dead Redis
    must never read as 'halt' (that would cancel every run on a cache blip)."""
    try:
        return bool(await redis_client.exists(HALT_KEY))
    except Exception:  # noqa: BLE001
        return False


async def scrape_all_sources(sources: list[str], scrape_fn, redis_client) -> bool:
    """Run one source-fn per source concurrently. Returns True when an operator
    halt cancelled the run (pending sources cancelled; finished work kept).

    Cancellation is safe: each source owns its HTTP session and releases its DB
    connection in a finally block, so a cancelled task unwinds cleanly instead
    of leaking. Raises CancelledError only if THIS task is cancelled.
    """
    tasks = {asyncio.create_task(scrape_fn(s)): s for s in sources}
    pending = set(tasks)
    while pending:
        done, pending = await asyncio.wait(pending, timeout=5)
        for d in done:
            if not d.cancelled():
                d.exception()  # retrieve to avoid 'never retrieved' warnings; errors are recorded by scrape_fn
        if pending and await halt_requested(redis_client):
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            return True
    return False

SCRAPER_MAP = {
    "remoteok": ("scrapers.remoteok", "RemoteOkScraper"),
    "arbeitnow": ("scrapers.arbeitnow", "ArbeitnowScraper"),
    "remotive": ("scrapers.remotive", "RemotiveScraper"),
    "github_jobs": ("scrapers.github_jobs", "GitHubJobsScraper"),
    "greenhouse": ("scrapers.greenhouse", "GreenhouseScraper"),
    "lever": ("scrapers.lever", "LeverScraper"),
    "adzuna": ("scrapers.adzuna", "AdzunaScraper"),
    "jooble": ("scrapers.jooble", "JoobleScraper"),
    "usajobs": ("scrapers.usajobs", "USAJobsScraper"),
    "workday": ("scrapers.workday", "WorkdayScraper"),
    "smartrecruiters": ("scrapers.smartrecruiters", "SmartRecruitersScraper"),
    "ashby": ("scrapers.ashby", "AshbyScraper"),
    "recruitee": ("scrapers.recruitee", "RecruiteeScraper"),
    "teamtailor": ("scrapers.teamtailor", "TeamtailorScraper"),
    "breezy": ("scrapers.breezy", "BreezyScraper"),
    "bamboohr": ("scrapers.bamboohr", "BambooHRScraper"),
    "personio": ("scrapers.personio", "PersonioScraper"),
    "duckduckgo": ("scrapers.duckduckgo_search", "DuckDuckGoScraper"),
    "reddit": ("scrapers.reddit_jobs", "RedditScraper"),
    "twitter": ("scrapers.twitter_jobs", "TwitterScraper"),
    "telegram": ("scrapers.telegram_jobs", "TelegramScraper"),
    "naukri": ("scrapers.naukri", "NaukriScraper"),
    "internshala": ("scrapers.internshala", "InternshalaScraper"),
    "indeed": ("scrapers.indeed", "IndeedScraper"),
    "foundit": ("scrapers.foundit", "FounditScraper"),
    "instahyre": ("scrapers.instahyre", "InstahyreScraper"),
    "wellfound": ("scrapers.angelco", "WellfoundScraper"),
    "glassdoor": ("scrapers.glassdoor", "GlassdoorScraper"),
    "shine": ("scrapers.shine", "ShineScraper"),
    "cutshort": ("scrapers.cutshort", "CutShortScraper"),
    "linkedin": ("scrapers.linkedin_jobs", "LinkedInJobsScraper"),
    "freshersworld": ("scrapers.freshersworld", "FreshersworldScraper"),
    "unstop": ("scrapers.unstop", "UnstopScraper"),
    "jobinsider": ("scrapers.jobinsider", "JobinsiderScraper"),
    "iimjobs": ("scrapers.iimjobs", "IimjobsScraper"),
    "timesjobs": ("scrapers.timesjobs", "TimesjobsScraper"),
    "facebook": ("scrapers.facebook_groups", "FacebookGroupsScraper"),
    "whatsapp": ("scrapers.whatsapp_listener", "WhatsAppListener"),
    "college_portals": ("scrapers.spiders.college_placement", "CollegePlacementSpider"),
    "apna": ("scrapers.apna", "ApnaScraper"),
    "workindia": ("scrapers.workindia", "WorkIndiaScraper"),
    "hirist": ("scrapers.hirist", "HiristScraper"),
    "classicjobs": ("scrapers.classicjobs", "ClassicJobsScraper"),
    "hackerearth": ("scrapers.hackerearth", "HackerEarthScraper"),
    "ambitionbox": ("scrapers.ambitionbox", "AmbitionBoxScraper"),
    "offcampus": ("scrapers.offcampus_aggregators", "OffCampusAggregatorsScraper"),
    "hasjob": ("scrapers.hasjob", "HasjobScraper"),
    "amazon": ("scrapers.amazon_jobs", "AmazonJobsScraper"),
    "elitmus": ("scrapers.elitmus", "ElitmusScraper"),
    "freejobalert": ("scrapers.freejobalert", "FreeJobAlertScraper"),
    "hackernews": ("scrapers.hackernews", "HackerNewsScraper"),
    "ripplehire": ("scrapers.ripplehire", "RippleHireScraper"),
}
DEFAULT_SOURCES = [
    # India-native fresher/entry-level portals (primary target).
    "naukri", "internshala", "freshersworld", "apna", "workindia",
    "shine", "timesjobs", "foundit", "instahyre", "cutshort",
    "unstop", "iimjobs", "jobinsider", "hirist", "classicjobs",
    "hackerearth", "ambitionbox", "offcampus", "hasjob",
    "elitmus", "freejobalert",
    # First-party hiring posts (HN Who's Hiring) + RippleHire campus/volume
    # discovery. Both gated hard on fresher/India relevance downstream.
    "hackernews", "ripplehire",
    # Public ATS career pages (real employer domains; India-filtered downstream,
    # best source of postable HR contacts). Greenhouse/Lever/Workday/Ashby/etc.
    "greenhouse", "lever", "workday", "ashby", "smartrecruiters",
    "bamboohr", "personio",
    # Discovery accelerators (India-keyed).
    "indeed", "duckduckgo", "amazon",
]

# Global / US boards kept available but NOT in the India-fresher default set
# (they're mostly filtered out by the India geo-gate, so running them daily just
# burns egress). Enable explicitly via job["sources"] or SCRAPE_SOURCES.
EXTRA_SOURCES = [
    "remoteok", "github_jobs", "arbeitnow", "adzuna", "jooble",
    "usajobs", "recruitee", "teamtailor", "breezy",
    "glassdoor", "wellfound", "linkedin", "twitter", "telegram",
    "reddit", "facebook", "whatsapp", "college_portals",
]


def resolve_sources(job_sources):
    """Choose which sources a run scrapes.

    Priority: explicit per-job list > SCRAPE_SOURCES env override > India-fresher
    DEFAULT_SOURCES. Keeps the operator able to retune the fleet without a code
    deploy (e.g. enable the global set, or narrow to a few reliable boards), and
    ignores unknown names rather than crashing the run.
    """
    if job_sources:
        return [x for x in job_sources if x in SCRAPER_MAP] or None
    override = os.environ.get("SCRAPE_SOURCES", "").strip()
    if override:
        picked = [x.strip() for x in override.split(",") if x.strip() in SCRAPER_MAP]
        if picked:
            return picked
    return DEFAULT_SOURCES


async def run_scraper(source: str, redis_client: redis.Redis, db=None, requested_by: str | None = None) -> tuple[int, str | None]:
    """Run a single scraper and enqueue its results.

    Returns (leads_count, error_message).
    """
    import importlib

    scraper_info = SCRAPER_MAP.get(source)
    if not scraper_info:
        return 0, f"Unknown source: {source}"

    module_path, class_name = scraper_info
    try:
        mod = importlib.import_module(module_path)
        scraper_cls = getattr(mod, class_name)
        scraper = scraper_cls(redis_client=redis_client, db=db)

        leads = await scraper.scrape_and_enqueue(requested_by=requested_by)
        logger.info(f"Source {source}: scraped and enqueued {leads} leads")
        if db is not None:
            # Source health is written HERE (success and failure): nothing else
            # records per-run health, which is why the table stayed empty.
            try:
                await db.execute(
                    """INSERT INTO source_health
                         (source_name, consecutive_failures, circuit_open_until, last_success_at, last_failure_reason)
                       VALUES ($1, 0, NULL, NOW(), NULL)
                       ON CONFLICT (source_name) DO UPDATE SET
                         consecutive_failures = 0, circuit_open_until = NULL,
                         last_success_at = NOW()""",
                    source,
                )
            except Exception as he:  # noqa: BLE001
                logger.debug(f"source_health success write skipped for {source}: {he}")
        return leads, None

    except Exception as e:
        logger.error(f"Source {source} failed: {e}", exc_info=True)
        if db is not None:
            try:
                await db.execute(
                    """INSERT INTO source_health
                         (source_name, consecutive_failures, circuit_open_until, last_failure_reason)
                       VALUES ($1, 1, NULL, $2)
                       ON CONFLICT (source_name) DO UPDATE SET
                         consecutive_failures = source_health.consecutive_failures + 1,
                         last_failure_reason = $2""",
                    source, str(e)[:500],
                )
            except Exception:  # noqa: BLE001
                pass
        return 0, str(e)


async def consume_scrape_queue(
    redis_client: redis.Redis,
    db_pool=None,
) -> int:
    """Consume scrape jobs from scrape_queue:requests.

    Each job contains:
      - run_id: unique identifier
      - sources: list of source names to scrape (or null for defaults)
      - run_type: 'scheduled' or 'manual'
      - triggered_by: user ID
    """
    processed = 0

    while True:
        job = None
        raw_msg: Any = None
        try:
            got = await reliable_brpop(redis_client, "scrape_queue:requests", timeout=10)
            if got is None:
                await asyncio.sleep(1)
                continue
            raw_msg, job = got
            # scrape_runs.id is uuid-typed; a caller that passes anything else used to
            # fail the INSERT with ValueError deep inside asyncpg, losing the run record
            # while the scrape itself succeeded. Coerce instead of trusting producers.
            raw_run_id = str(job.get("run_id") or "")
            try:
                run_id = str(uuid.UUID(raw_run_id))
            except ValueError:
                logger.warning(f"run_id {raw_run_id!r} is not a UUID; generating one")
                run_id = str(uuid.uuid4())
            sources = resolve_sources(job.get("sources")) or []
            run_type = job.get("run_type", "manual")
            triggered_by = job.get("triggered_by")

            # Stop honoring point 1: a queued job that starts after an operator
            # halt is skipped, recorded as cancelled, and acked — never run.
            if await halt_requested(redis_client):
                logger.info(f"Scrape job {run_id} skipped: army halted by operator")
                if db_pool:
                    async with db_pool.acquire() as conn:
                        await conn.execute(
                            """
                            INSERT INTO scrape_runs
                              (id, started_at, finished_at, sources_attempted,
                               sources_succeeded, sources_circuit_broken, leads_found, errors)
                            VALUES ($1, NOW(), NOW(), $2, 0, '{}', 0, $3)
                            """,
                            run_id,
                            len(sources),
                            json.dumps({
                                "sources": sources,
                                "run_type": run_type,
                                "triggered_by": triggered_by,
                                "cancelled": "stopped by operator before start",
                            }),
                        )
                await ack(redis_client, "scrape_queue:requests", raw_msg)
                processed += 1
                continue

            logger.info(f"Scrape job {run_id} ({run_type}): sources={sources}")

            results: dict[str, Any] = {
                "run_id": run_id,
                "sources_attempted": len(sources),
                "sources_succeeded": 0,
                "sources_failed": [],
                "leads_found": 0,
            }
            per_source_counts: dict[str, int] = {}

            async def scrape_source(src: str):
                db = None
                if db_pool:
                    db = await db_pool.acquire()
                try:
                    count, err = await run_scraper(src, redis_client, db, requested_by=triggered_by)
                    if err:
                        results["sources_failed"].append({"source": src, "error": err})
                    else:
                        results["sources_succeeded"] += 1
                    results["leads_found"] += count
                    per_source_counts[src] = count
                finally:
                    if db and db_pool:
                        await db_pool.release(db)

            # Halt-aware fan-out: a stop cancels pending sources promptly
            # (finished work is kept). Plain gather would run to completion
            # regardless of the operator.
            stopped = await scrape_all_sources(sources, scrape_source, redis_client)
            if stopped:
                results["sources_failed"].append({"source": "_army", "error": "stopped by operator"})
                logger.info(f"Scrape job {run_id} stopped by operator: {results}")

            # Persist run report to scrape_runs (§9.6)
            if db_pool:
                async with db_pool.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO scrape_runs
                          (id, started_at, finished_at, sources_attempted,
                           sources_succeeded, sources_circuit_broken, leads_found, errors)
                        VALUES ($1, NOW(), NOW(), $2, $3, $4, $5, $6)
                        """,
                        run_id,
                        results["sources_attempted"],
                        results["sources_succeeded"],
                        [f["source"] for f in results["sources_failed"]],
                        results["leads_found"],
                        # leads_deduped intentionally omitted: dedupe happens later in the
                        # normalizer consumer, so this writer cannot know it. It used to insert a
                        # literal 0, which made every run claim "0 duplicates" -- an unwritten
                        # number presented as fact. NULL now reads as unknown.
                        json.dumps({
                            "sources": sources,
                            "run_type": run_type,
                            "triggered_by": triggered_by,
                            "errors": results["sources_failed"],
                            "stopped": stopped,
                        }),
                    )

            processed += 1
            await ack(redis_client, "scrape_queue:requests", raw_msg)
            logger.info(f"Scrape job {run_id} complete: {results}")

            # Wave quality gate (Fallback Corps): on a failed or barren wave,
            # sibling soldiers compensate with ONE bounded fallback wave.
            # Compensation jobs (depth>=1) never compensate further: no chains.
            # Suppressed after an operator stop: re-enqueueing sources the user
            # just halted would restart the very work they cancelled.
            if not stopped:
                try:
                    from .army_registry import maybe_fallback_wave
                    sibs = await maybe_fallback_wave(
                        redis_client, job, sources, results, per_source_counts,
                    )
                    if sibs:
                        logger.warning(f"Fallback wave queued -> {sibs}")
                except Exception as e:  # noqa: BLE001
                    logger.debug(f"Fallback-wave check skipped: {e}")
            else:
                logger.info(f"Fallback wave suppressed for stopped job {run_id}")

        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in scrape_queue: {e}")
            if raw_msg is not None:
                await ack(redis_client, "scrape_queue:requests", raw_msg)
        except Exception as e:
            logger.error(f"Consumer error in scrape_queue: {e}", exc_info=True)
            try:
                if raw_msg is not None:
                    await ack(redis_client, "scrape_queue:requests", raw_msg)
                await requeue_or_dlq(redis_client, "scrape_queue:requests", job)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(5)

    return processed
