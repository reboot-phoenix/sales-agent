import os
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from fastapi import Depends, FastAPI, Header, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
import uuid

from scrapers.utils.redis import get_redis
from scrapers.utils.db import get_db_pool

logger = logging.getLogger(__name__)

# Shared asyncpg pool captured at startup so the on-demand /army/run sweep can
# query under-enriched leads without creating a second pool.
_db_pool = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Replaces deprecated @app.on_event("startup"/"shutdown"). Consumers start
    # here so they are running before the service reports ready.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.create_task(start_consumers())
    yield
    # Shutdown: nothing persistent to close (pools/clients are lazy singletons).


app = FastAPI(
    title="HireGen Scraper Fleet API",
    description="Python worker service for scraping, enrichment, verification, and AI drafting",
    version="0.1.0",
    lifespan=lifespan,
)

WORKER_API_SECRET = os.environ.get("WORKER_API_SECRET", "")


def require_worker_key(x_worker_key: Optional[str] = Header(None)):
    """Gate the mutating endpoints.

    This service triggers scrapes and spends paid vendor credits (Snov.io, ContactOut
    bill per lookup), so an unauthenticated POST used to let anyone run the army on
    demand. Binding the port to loopback limits who can reach it but is not
    authentication -- anything else on this host, or a future proxy, still could.

    Fails CLOSED: with no secret configured, every mutating call is refused rather than
    silently wide open, so a missing environment variable shows up as a broken deploy
    instead of an exposed endpoint.
    """
    if not WORKER_API_SECRET:
        raise HTTPException(503, "worker API is not configured (WORKER_API_SECRET unset)")
    if x_worker_key != WORKER_API_SECRET:
        raise HTTPException(401, "invalid worker key")
    return True


class ScrapeRequest(BaseModel):
    sources: Optional[list[str]] = None
    run_type: str = "auto"
    triggered_by: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    services: dict


@app.get("/health", response_model=HealthResponse)
async def health():
    # Liveness of the backing services, not just client construction:
    # get_redis()/get_db_pool() return truthy handles even when the server is
    # down, so ping a command to report honestly.
    try:
        rc = get_redis()
        await rc.ping()
        redis_ok = True
    except Exception:
        redis_ok = False
    try:
        db_pool = await get_db_pool()
        async with db_pool.acquire() as _c:
            await _c.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        db_ok = False
    return HealthResponse(
        status="ok",
        services={
            "redis": "configured" if redis_ok else "down",
            "database": "configured" if db_ok else "down",
            "scrapers": [
                "remoteok", "arbeitnow", "remotive", "github_jobs",
                "greenhouse", "lever", "adzuna", "jooble",
                "usajobs", "workday", "smartrecruiters", "ashby",
                "recruitee", "teamtailor", "breezy",
                "duckduckgo", "reddit", "twitter", "telegram",
            ],
        },
    )


@app.get("/scrapers")
async def list_scrapers(_auth: bool = Depends(require_worker_key)):
    """Scraper catalogue + which sources are active.

    Gated with the same worker key as the mutating endpoints. It used to be open
    (GET only, "read endpoints are harmless"), but it enumerates every scraper
    module and its tier -- an accurate inventory of where to aim attacks -- and
    `active` is derived from the DB source toggles, i.e. internal configuration.
    Loopback binding limits who can reach it, it does not authenticate.
    """
    from scrapers.scrape_consumer import SCRAPER_MAP, DEFAULT_SOURCES

    return {
        "available": [
            {"name": name, "module": mod, "tier": _get_tier(name)}
            for name, (mod, _) in SCRAPER_MAP.items()
        ],
        "active": DEFAULT_SOURCES,
    }


def _get_tier(name: str) -> int:
    tier_map = {
        "remoteok": 1, "arbeitnow": 1, "remotive": 1, "github_jobs": 1,
        "adzuna": 1, "jooble": 1, "usajobs": 1,
        "greenhouse": 3, "lever": 3, "workday": 3, "smartrecruiters": 3,
        "ashby": 3, "recruitee": 3, "teamtailor": 3, "breezy": 3,
        "linkedin": 2, "naukri": 2, "internshala": 2, "indeed": 2,
        "foundit": 2, "instahyre": 2, "freshersworld": 2,
        "angelist": 2, "glassdoor": 2, "shine": 2, "cutshort": 2,
        "duckduckgo": 4, "reddit": 4, "twitter": 4, "telegram": 4,
        "facebook": 4, "college": 4,
        "apna": 2, "workindia": 2, "hirist": 2, "classicjobs": 2,
    }
    return tier_map.get(name, 3)


@app.post("/scrape/trigger")
async def trigger_scrape(req: ScrapeRequest, _auth: bool = Depends(require_worker_key)):
    redis_client = get_redis()
    run_id = str(uuid.uuid4())
    await redis_client.lpush(
        "scrape_queue:requests",
        json.dumps({
            "run_id": run_id,
            "run_type": req.run_type,
            "sources": req.sources,
            "triggered_by": req.triggered_by,
            "triggered_at": datetime.now(timezone.utc).isoformat(),
        }),
    )
    return {"message": "Scrape job queued", "run_id": run_id}


@app.get("/army/status")
async def army_status(_auth: bool = Depends(require_worker_key)):
    """Queue depths for every pipeline stage — drives the frontend live status.

    The frontend reaches this through the Node API (GET /live/stats proxies it
    with the server-side worker key), so a browser never needs a direct key.
    Unguarded, it was a free pipeline-ops readout for anything on the host.
    """
    """Queue depths for every pipeline stage — drives the frontend live status."""
    redis_client = get_redis()
    async def llen(k):
        try:
            return await redis_client.llen(k)
        except Exception:  # noqa: BLE001
            return -1
    return {
        "raw": await llen("raw_leads_queue:requests"),
        "enrichment": await llen("enrichment_queue:requests"),
        "verification": await llen("verification_queue:requests"),
        "draft": await llen("draft_queue:requests"),
        "scrape": await llen("scrape_queue:requests"),
        "halted": await _halted(redis_client),
    }


async def _halted(redis_client) -> bool:
    try:
        from scrapers.scrape_consumer import halt_requested
        return await halt_requested(redis_client)
    except Exception:  # noqa: BLE001
        return False


@app.post("/army/stop")
async def army_stop(_auth: bool = Depends(require_worker_key)):
    """Cooperative stop: in-flight sources are cancelled within seconds
    (finished work kept), queued scrape jobs are discarded, and a TTL-bounded
    halt flag blocks subsequently-starting jobs until it expires. Downstream
    queues (enrich→verify→draft) drain naturally — discovered leads are never
    stranded mid-pipeline. Returns stopped:false without setting the flag when
    nothing is running, so a stray stop can never wedge future runs."""
    from scrapers.scrape_consumer import HALT_KEY, HALT_TTL_SECONDS
    redis_client = get_redis()
    async def llen(k):
        try:
            return await redis_client.llen(k)
        except Exception:  # noqa: BLE001
            return -1
    queues = {
        "raw": await llen("raw_leads_queue:requests"),
        "enrichment": await llen("enrichment_queue:requests"),
        "verification": await llen("verification_queue:requests"),
        "draft": await llen("draft_queue:requests"),
        "scrape": await llen("scrape_queue:requests"),
    }
    active = sum(v for v in queues.values() if v > 0)
    if active <= 0 and not await _halted(redis_client):
        return {"stopped": False, "reason": "nothing running", "queues": queues}
    try:
        await redis_client.set(
            HALT_KEY, datetime.now(timezone.utc).isoformat(), ex=HALT_TTL_SECONDS)
    except Exception as e:  # noqa: BLE001
        return {"stopped": False, "reason": f"halt flag unwritable: {e}", "queues": queues}
    cleared = 0
    try:
        cleared = int(await redis_client.llen("scrape_queue:requests") or 0)
        if cleared:
            await redis_client.delete("scrape_queue:requests")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"army stop: backlog clear failed: {e}")
    logger.info(f"Army stop: halt set, {cleared} queued scrape jobs discarded")
    return {"stopped": True, "cleared_queued_jobs": cleared, "queues": queues}


@app.post("/army/run")
async def army_run(req: ScrapeRequest, _auth: bool = Depends(require_worker_key)):
    """One-click army: enqueue a full-fleet scrape AND an immediate
    re-enrichment sweep so leads already in the DB but missing contacts get the
    fallback cascade retried now (not just at the next daily tick). Scraping and
    the sweep are independent; chaining handles enrich→verify→draft after.
    """
    redis_client = get_redis()
    run_id = str(uuid.uuid4())
    sources = req.sources
    if not sources:
        # No explicit list: honor the Settings source toggles (None = all).
        try:
            from scrapers.scheduler import load_enabled_sources
            sources = await load_enabled_sources(_db_pool)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"source toggles unreadable, using defaults: {e}")
            sources = None
    try:
        # An explicit new run overrides a previous stop: without this, the
        # TTL-bounded halt flag would cancel the very run the operator just
        # confirmed at job-start (toast says "deployed", nothing runs).
        from scrapers.scrape_consumer import HALT_KEY
        await redis_client.delete(HALT_KEY)
    except Exception:  # noqa: BLE001
        pass
    await redis_client.lpush(
        "scrape_queue:requests",
        json.dumps({
            "run_id": run_id,
            "run_type": "manual",
            "sources": sources,
            "triggered_by": req.triggered_by,
            "triggered_at": datetime.now(timezone.utc).isoformat(),
        }),
    )
    swept = 0
    try:
        from scrapers.scheduler import sweep_unenriched
        swept = await sweep_unenriched(redis_client, _db_pool)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"army sweep failed (scrape still queued): {e}")
    return {"message": "Army run queued", "run_id": run_id, "sweep_reenqueued": swept}


async def periodic_sweeps(redis_client, db_pool, interval: int | None = None) -> None:
    """Hourly self-healing: re-enrich still-contactless leads, re-verify still-
    unverified contacts. Without this, a lead that fails OSINT right after the
    post-scrape sweep waits a full day for its next retry; an hourly cadence
    keeps the 12h rate-limit windows flowing so coverage converges instead of
    stepping once a day. Set SWEEP_INTERVAL_SECONDS=0 to disable.
    """
    interval = interval if interval is not None else int(
        os.environ.get("SWEEP_INTERVAL_SECONDS", "3600") or 3600
    )
    if interval <= 0 or db_pool is None:
        return
    from scrapers.scheduler import sweep_unenriched, sweep_unverified
    log = logging.getLogger(__name__)
    while True:
        try:
            await asyncio.sleep(interval)
            n_enrich = await sweep_unenriched(redis_client, db_pool)
            n_verify = await sweep_unverified(redis_client, db_pool)
            if n_enrich or n_verify:
                log.info(f"Periodic sweeps: re-enriched {n_enrich}, re-verified {n_verify}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning(f"Periodic sweep failed: {e}")


async def start_consumers():
    """Start background queue consumers per SRS §9.1."""
    from scrapers.scrape_consumer import consume_scrape_queue
    from scrapers.normalizer import run_normalizer
    from scrapers.enrichment_worker import consume_enrichment_queue
    from scrapers.verification_worker import consume_verification_queue
    from scrapers.draft_worker import consume_draft_queue
    from scrapers.send_worker import consume_send_queue
    from scrapers.verify_send_worker import consume_verify_send_queue
    from scrapers.scheduler import daily_scrape_scheduler

    redis_client = get_redis()

    try:
        db_pool = await get_db_pool()
    except Exception:
        db_pool = None
    global _db_pool
    _db_pool = db_pool

    tasks = []
    if redis_client:
        # Crash recovery first: jobs stranded in :processing lists (worker died
        # between pop and ack) go back to their queues before consumers start.
        try:
            from scrapers.queue import reclaim_processing, dlq_depth
            reclaimed = await reclaim_processing(redis_client, [
                "scrape_queue:requests", "raw_leads_queue:requests",
                "enrichment_queue:requests", "verification_queue:requests",
                "draft_queue:requests", "send_queue:requests",
                "verify_send_queue:requests",
            ])
            total_dlq = 0
            for qn in list(reclaimed):
                total_dlq += await dlq_depth(redis_client, qn)
            logger = logging.getLogger(__name__)
            logger.info(f"Boot reclaim: {reclaimed} (DLQ depth total: {total_dlq})")
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning(f"Boot reclaim failed (queues still consumable): {e}")
        # DLQ replay: anything parked in {queue}:dlq already exhausted its
        # in-run attempts, but those failures were usually transient (search
        # engines 429ing, a dead IPv6 route, a restarting dependency). Left
        # alone they rot forever — 138 leads were stranded there while the
        # daily sweeps kept only the DB-side backlog healthy. Replay a bounded
        # slice back into the live queue at boot (enrichment first: re-running
        # it re-chains the downstream stages).
        try:
            from scrapers.queue import dlq_depth
            _replayed = {}
            for _qn in ("enrichment_queue:requests", "verification_queue:requests",
                        "draft_queue:requests", "verify_send_queue:requests",
                        "raw_leads_queue:requests"):
                _depth = await dlq_depth(redis_client, _qn)
                if not _depth:
                    continue
                _n = 0
                while _n < min(_depth, 25):
                    raw = await redis_client.rpop(f"{_qn}:dlq")
                    if raw is None:
                        break
                    await redis_client.lpush(_qn, raw)
                    _n += 1
                _replayed[_qn] = _n
            if _replayed:
                logging.getLogger(__name__).warning(f"DLQ replay at boot: {_replayed}")
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning(f"DLQ replay failed (skipped): {e}")
        tasks.append(asyncio.create_task(consume_scrape_queue(redis_client, db_pool)))
        tasks.append(asyncio.create_task(run_normalizer(redis_client, db_pool)))
        # daily full-fleet heartbeat (India jobs -> enrich -> verify -> draft -> send)
        tasks.append(asyncio.create_task(daily_scrape_scheduler(redis_client, db_pool=db_pool)))

        if db_pool:
            # Contact enrichment is the product priority, but the keyless OSINT
            # cascade is latency-bound (crt.sh / search-engine timeouts), so a
            # single consumer drains the queue ~1 lead/min. Run a small bounded
            # pool to multiply throughput. ponytail: 4 is tuned to the 10-conn DB
            # pool + shared search-engine rate limits; raise ENRICH_CONCURRENCY as
            # paid-provider keys (which return instantly) are added.
            _enrich_n = max(1, int(os.environ.get("ENRICH_CONCURRENCY", "4") or 4))
            for _ in range(_enrich_n):
                tasks.append(asyncio.create_task(consume_enrichment_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_verification_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_draft_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_send_queue(redis_client, db_pool)))
            tasks.append(asyncio.create_task(consume_verify_send_queue(redis_client, db_pool)))
            # Hourly self-healing sweeps (re-enrich + re-verify) so coverage
            # converges continuously instead of once per daily run.
            tasks.append(asyncio.create_task(periodic_sweeps(redis_client, db_pool)))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
