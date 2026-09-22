"""The three scraper armies: jobs, hackathons, colleges.

Design guarantees:

  * Isolation — an adapter failure is recorded against that source; the army and
    the other two armies continue.
  * Durable runs — every army execution has an ``army_runs`` row with live
    counters, so the UI can poll progress without holding a request open.
  * No lead loss — adapters persist each discovered item to
    ``raw_discovery_records`` BEFORE the normalizer runs; a crash in any later
    stage leaves the row recoverable, and a boot reclaim restores rows stranded
    in 'processing'.
  * Concurrency — the three armies are independent queue consumers, so the 02:00
    schedule runs them in parallel rather than sequentially.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

ARMY_QUEUE = "army_queue:requests"
DOMAINS = ("jobs", "hackathons", "colleges")
# Per-domain default caps; adapters are already rate-limited by the HTTP layer.
ADAPTER_CONCURRENCY = int(os.environ.get("ARMY_ADAPTER_CONCURRENCY", "4") or 4)
# A raw row stuck in 'processing' for longer than this was abandoned by a crashed
# worker (a healthy normalize is seconds) and is safe to re-queue.
STALLED_RAW_MINUTES = int(os.environ.get("RAW_STALLED_MINUTES", "30") or 30)


def adapter_registry() -> dict[str, tuple]:
    from .colleges.adapters import COLLEGE_ADAPTERS
    from .hackathons.adapters import HACKATHON_ADAPTERS
    return {"hackathons": HACKATHON_ADAPTERS, "colleges": COLLEGE_ADAPTERS}


def adapters_for(domain: str, redis_client=None, db=None, only: Optional[list[str]] = None,
                 include_paused: bool = False) -> list:
    """Instantiate the adapters for a domain.

    Sources marked ``enabled_by_default = False`` need a terms/reliability review
    before they run, so they are skipped unless the caller names them explicitly
    (``only=[...]``) or asks for them with ``include_paused=True``. That keeps a
    default army run to the sources we have decided we may fetch.
    """
    classes = adapter_registry().get(domain, ())
    instances = [cls(redis_client=redis_client, db=db) for cls in classes]
    if only:
        wanted = {s.strip() for s in only}
        return [a for a in instances if a.name in wanted]
    if not include_paused:
        instances = [a for a in instances if a.enabled_by_default]
    return instances


async def register_sources(conn, domain: str, adapters: list) -> None:
    """Keep the source registry in sync (enable/disable + health visibility)."""
    for adapter in adapters:
        meta = adapter.source_metadata()
        try:
            await conn.execute(
                """
                INSERT INTO scraper_sources (domain, name, adapter, tier, enabled, health_status, config)
                VALUES ($1,$2,$3,$4,$5,'unknown',$6::jsonb)
                ON CONFLICT (domain, name) DO UPDATE SET
                  adapter=EXCLUDED.adapter, tier=EXCLUDED.tier,
                  config=EXCLUDED.config, updated_at=NOW()
                """,
                domain, adapter.name, meta["adapter"], meta.get("tier", 3),
                bool(adapter.enabled_by_default),
                json.dumps({"base_url": meta.get("base_url"),
                            "verification_note": meta.get("verification_note")}),
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("source registry upsert failed for %s: %s", adapter.name, e)


async def record_source_health(conn, domain: str, adapter, result) -> None:
    status = "SOURCE_TEMPORARILY_UNAVAILABLE" if result.unavailable else "healthy"
    try:
        await conn.execute(
            """
            UPDATE scraper_sources SET
              health_status=$3, last_run_at=NOW(),
              last_success_at=CASE WHEN $3='healthy' THEN NOW() ELSE last_success_at END,
              consecutive_failures=CASE WHEN $3='healthy' THEN 0 ELSE consecutive_failures + 1 END,
              last_error=$4, updated_at=NOW()
            WHERE domain=$1 AND name=$2
            """,
            domain, adapter.name, status,
            (result.errors[0] if result.errors else None),
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("source health update failed: %s", e)


async def record_error(conn, run_id: Optional[str], domain: str, source: str, error: str, attempt: int = 1) -> None:
    try:
        await conn.execute(
            "INSERT INTO scraper_errors (run_id, domain, source, error, attempt) VALUES ($1,$2,$3,$4,$5)",
            _as_uuid(run_id), domain, source, error[:1000], attempt,
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("scraper error record failed: %s", e)


def _as_uuid(value: Any) -> Optional[str]:
    if not value:
        return None
    import uuid
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError):
        return None


async def _discover_domain(domain: str, adapters: list, db_pool, run_id: Optional[str]) -> dict[str, Any]:
    """Run every adapter concurrently; persist raw; never abort on one failure."""
    sem = asyncio.Semaphore(max(1, ADAPTER_CONCURRENCY))
    totals = {"discovered": 0, "stored": 0, "duplicates": 0, "sources_attempted": len(adapters),
              "sources_succeeded": 0, "errors": 0}
    worker_status: list[dict[str, Any]] = []

    async def one(adapter) -> None:
        async with sem:
            # run() persists raw + records source health itself when the pool is
            # handed to it — persistence no longer depends on the orchestrator
            # surviving to the next line (no-lead-loss).
            outcome = await adapter.run(db_pool, run_id=run_id)
            records, result = outcome
            stored, duplicates = result.stored, result.duplicates
            if db_pool is None and records:
                # No db handed to run(): emulate the old behavior for callers
                # without persistence so counters still reflect discovery.
                stored = len(records)
            totals["discovered"] += result.discovered
            totals["stored"] += stored
            totals["duplicates"] += duplicates
            if not result.unavailable:
                totals["sources_succeeded"] += 1
            totals["errors"] += len(result.errors)
            worker_status.append({
                "source": adapter.name,
                "discovered": result.discovered,
                "stored": stored,
                "duplicates": duplicates,
                "unavailable": result.unavailable,
                "duration_ms": result.duration_ms,
                "errors": result.errors[:3],
            })
            if db_pool is not None:
                async with db_pool.acquire() as conn:
                    await record_source_health(conn, domain, adapter, result)
                    for err in result.errors[:3]:
                        await record_error(conn, run_id, domain, adapter.name, err)
            if result.unavailable:
                logger.warning("army %s: %s unavailable (%s)", domain, adapter.name,
                               result.errors[:1])
            else:
                logger.info("army %s: %s -> %d discovered, %d new raw",
                            domain, adapter.name, result.discovered, stored)

    await asyncio.gather(*(one(a) for a in adapters), return_exceptions=False)
    totals["worker_status"] = worker_status
    return totals


async def reclaim_stalled_raw(db_pool, domain: Optional[str] = None) -> int:
    """Boot/run recovery: raw rows abandoned in 'processing' by a dead worker."""
    if db_pool is None:
        return 0
    try:
        async with db_pool.acquire() as conn:
            status = await conn.execute(
                f"""
                UPDATE raw_discovery_records
                   SET status='stored', error=COALESCE(error,'reclaimed after stalled processing')
                 WHERE status='processing'
                   AND processed_at IS NULL
                   AND fetched_at < NOW() - ($1 || ' minutes')::interval
                   {'' if domain is None else "AND domain=$2"}
                """,
                str(STALLED_RAW_MINUTES), *([] if domain is None else [domain]),
            )
        try:
            return int(str(status).split()[-1])
        except (ValueError, IndexError):
            return 0
    except Exception as e:  # noqa: BLE001
        logger.warning("stalled raw reclaim failed: %s", e)
        return 0


async def create_run(db_pool, domain: str, run_type: str, triggered_by: Optional[str],
                     run_id: Optional[str] = None) -> Optional[str]:
    if db_pool is None:
        return run_id
    async with db_pool.acquire() as conn:
        if run_id:
            row = await conn.fetchrow("SELECT id FROM army_runs WHERE id=$1", _as_uuid(run_id))
            if row:
                await conn.execute(
                    "UPDATE army_runs SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=$1",
                    row["id"],
                )
                return str(row["id"])
        return str(await conn.fetchval(
            """
            INSERT INTO army_runs (domain, run_type, status, triggered_by, started_at)
            VALUES ($1,$2,'running',$3,NOW()) RETURNING id
            """,
            domain, run_type, _as_uuid(triggered_by),
        ))


async def update_run(db_pool, run_id: Optional[str], **fields: Any) -> None:
    if db_pool is None or not run_id:
        return
    allowed = {
        "status", "finished_at", "sources_attempted", "sources_succeeded",
        "records_discovered", "records_inserted", "records_updated", "duplicates_removed",
        "contacts_discovered", "enrichments_done", "predictions_generated",
        "errors_count", "retries", "checkpoint", "worker_status", "error",
    }
    sets, values = [], []
    idx = 1
    for key, value in fields.items():
        if key not in allowed:
            continue
        sets.append(f"{key}=${idx}" + ("::jsonb" if key in ("checkpoint", "worker_status", "error") else ""))
        values.append(json.dumps(value, default=str) if key in ("checkpoint", "worker_status", "error") else value)
        idx += 1
    if not sets:
        return
    sets.append("updated_at=NOW()")
    values.append(_as_uuid(run_id))
    try:
        async with db_pool.acquire() as conn:
            await conn.execute(
                f"UPDATE army_runs SET {', '.join(sets)} WHERE id=${idx}", *values
            )
    except Exception as e:  # noqa: BLE001
        logger.debug("army run update failed: %s", e)


async def progress(run_id: Optional[str]) -> Optional[dict[str, Any]]:
    """Update progress from the live queue/raw state for a run."""
    return None  # DB-backed progress is read by the API; kept for symmetry


async def execute_hackathons(db_pool, redis_client, run_id: Optional[str], run_type: str,
                             triggered_by: Optional[str], sources: Optional[list[str]],
                             *, fetch_pages: bool = True) -> dict[str, Any]:
    from .hackathons.worker import run_hackathon_pipeline

    adapters = adapters_for("hackathons", redis_client, db_pool, only=sources)
    summary: dict[str, Any] = {"domain": "hackathons", "run_id": run_id}
    if db_pool is not None:
        async with db_pool.acquire() as conn:
            await register_sources(conn, "hackathons", adapters)
            await conn.execute(
                "UPDATE army_runs SET status='running', sources_attempted=$2 WHERE id=$1",
                _as_uuid(run_id), len(adapters),
            )
    discovered = await _discover_domain("hackathons", adapters, db_pool, run_id)
    summary.update(discovered)
    await update_run(db_pool, run_id, checkpoint={"stage": "discovery_complete"},
                     sources_attempted=discovered["sources_attempted"],
                     sources_succeeded=discovered["sources_succeeded"],
                     records_discovered=discovered["discovered"],
                     duplicates_removed=discovered["duplicates"],
                     errors_count=discovered["errors"],
                     worker_status=discovered["worker_status"])
    pipeline = await run_hackathon_pipeline(db_pool, run_id, fetch_pages=fetch_pages)
    summary["pipeline"] = pipeline
    norm = (pipeline or {}).get("normalize") or {}
    enrich = (pipeline or {}).get("enrich") or {}
    prediction = (pipeline or {}).get("prediction") or {}
    await update_run(
        db_pool, run_id,
        status="completed" if discovered["sources_succeeded"] else "partial",
        finished_at=datetime.now(timezone.utc),
        records_inserted=int(norm.get("inserted") or 0),
        records_updated=int(norm.get("updated") or 0),
        contacts_discovered=int(enrich.get("contacts_inserted") or 0),
        enrichments_done=int(enrich.get("enriched") or 0),
        predictions_generated=int(prediction.get("predictions_created") or 0),
        checkpoint={"stage": "done", "pipeline": {k: v for k, v in (pipeline or {}).items()
                                                   if k in ("normalize", "enrich")}},
    )
    return summary


async def execute_colleges(db_pool, redis_client, run_id: Optional[str], run_type: str,
                           triggered_by: Optional[str], sources: Optional[list[str]],
                           *, fetch_pages: bool = True) -> dict[str, Any]:
    from .colleges.worker import run_college_pipeline

    adapters = adapters_for("colleges", redis_client, db_pool, only=sources)
    summary: dict[str, Any] = {"domain": "colleges", "run_id": run_id}
    if db_pool is not None:
        async with db_pool.acquire() as conn:
            await register_sources(conn, "colleges", adapters)
            await conn.execute(
                "UPDATE army_runs SET status='running', sources_attempted=$2 WHERE id=$1",
                _as_uuid(run_id), len(adapters),
            )
    discovered = await _discover_domain("colleges", adapters, db_pool, run_id)
    summary.update(discovered)
    await update_run(db_pool, run_id, checkpoint={"stage": "discovery_complete"},
                     sources_attempted=discovered["sources_attempted"],
                     sources_succeeded=discovered["sources_succeeded"],
                     records_discovered=discovered["discovered"],
                     duplicates_removed=discovered["duplicates"],
                     errors_count=discovered["errors"],
                     worker_status=discovered["worker_status"])
    pipeline = await run_college_pipeline(db_pool, run_id, fetch_pages=fetch_pages)
    summary["pipeline"] = pipeline
    norm = (pipeline or {}).get("normalize") or {}
    enrich = (pipeline or {}).get("enrich") or {}
    await update_run(
        db_pool, run_id,
        status="completed" if discovered["sources_succeeded"] else "partial",
        finished_at=datetime.now(timezone.utc),
        records_inserted=int(norm.get("inserted") or 0),
        records_updated=int(norm.get("updated") or 0),
        contacts_discovered=int(enrich.get("enriched") or 0),
        enrichments_done=int(enrich.get("processed") or 0),
        checkpoint={"stage": "done"},
    )
    return summary


async def execute_jobs(db_pool, redis_client, run_id: Optional[str], run_type: str,
                       triggered_by: Optional[str], sources: Optional[list[str]]) -> dict[str, Any]:
    """Jobs army: uses the existing, proven job scrape pipeline.

    We do not duplicate 50 job scrapers here — the army triggers the existing
    consumer and links the army run to the scrape run so progress stays visible.
    """
    if redis_client is None:
        return {"domain": "jobs", "error": "no_redis"}
    import uuid
    scrape_run_id = str(uuid.uuid4())
    await redis_client.lpush(
        "scrape_queue:requests",
        json.dumps({
            "run_id": scrape_run_id,
            "run_type": run_type,
            "sources": sources,
            "triggered_by": triggered_by or "army",
            "army_run_id": run_id,
            "triggered_at": datetime.now(timezone.utc).isoformat(),
        }),
    )
    await update_run(db_pool, run_id, status="running",
                     checkpoint={"stage": "scrape_enqueued", "scrape_run_id": scrape_run_id})
    return {"domain": "jobs", "run_id": run_id, "scrape_run_id": scrape_run_id, "queued": True}


async def execute_army(domain: str, db_pool, redis_client, run_id: Optional[str],
                       run_type: str = "manual", triggered_by: Optional[str] = None,
                       sources: Optional[list[str]] = None, *, fetch_pages: bool = True) -> dict[str, Any]:
    """Dispatch one army. Never raises: failures mark the run and return."""
    run_id = await create_run(db_pool, domain, run_type, triggered_by, run_id=run_id)
    try:
        if domain == "hackathons":
            return await execute_hackathons(db_pool, redis_client, run_id, run_type, triggered_by, sources,
                                            fetch_pages=fetch_pages)
        if domain == "colleges":
            return await execute_colleges(db_pool, redis_client, run_id, run_type, triggered_by, sources,
                                          fetch_pages=fetch_pages)
        if domain == "jobs":
            return await execute_jobs(db_pool, redis_client, run_id, run_type, triggered_by, sources)
        raise ValueError(f"unknown domain {domain}")
    except Exception as e:  # noqa: BLE001
        logger.error("army %s failed: %s", domain, e, exc_info=True)
        await update_run(db_pool, run_id, status="failed", finished_at=datetime.now(timezone.utc),
                         error={"message": str(e)[:500]})
        if db_pool is not None:
            try:
                async with db_pool.acquire() as conn:
                    await record_error(conn, run_id, domain, "army", str(e))
            except Exception:  # noqa: BLE001
                pass
        return {"domain": domain, "run_id": run_id, "error": str(e)[:200]}


async def enqueue_army(redis_client, domain: str, *, run_type: str = "manual",
                       triggered_by: Optional[str] = None, run_id: Optional[str] = None,
                       sources: Optional[list[str]] = None) -> Optional[str]:
    """Queue an army run. Returns the run id (created here when absent)."""
    if redis_client is None:
        return run_id
    payload = {
        "domain": domain,
        "run_type": run_type,
        "triggered_by": triggered_by,
        "run_id": run_id,
        "sources": sources,
        "queued_at": datetime.now(timezone.utc).isoformat(),
    }
    await redis_client.lpush(ARMY_QUEUE, json.dumps(payload))
    return run_id


async def run_all_armies(db_pool, redis_client, *, run_type: str = "scheduled",
                         triggered_by: Optional[str] = None) -> dict[str, Any]:
    """Queue all three armies together; consumers run them concurrently.

    Used by the 02:00 schedule. Each domain is independent, so one unavailable
    source set or one failed army cannot stop the other two.
    """
    ids: dict[str, Any] = {}
    for domain in DOMAINS:
        try:
            ids[domain] = await enqueue_army(redis_client, domain, run_type=run_type,
                                             triggered_by=triggered_by)
        except Exception as e:  # noqa: BLE001
            logger.error("failed to enqueue %s army: %s", domain, e)
            ids[domain] = {"error": str(e)[:200]}
    return ids


async def consume_army_queue(redis_client, db_pool) -> None:
    """Consumer for army_queue:requests. One job at a time per consumer."""
    from ..queue import ack, reliable_brpop, requeue_or_dlq

    while True:
        raw_msg = None
        payload = None
        try:
            got = await reliable_brpop(redis_client, ARMY_QUEUE, timeout=10)
            if got is None:
                await asyncio.sleep(1)
                continue
            raw_msg, payload = got
            domain = str(payload.get("domain") or "")
            if domain not in DOMAINS:
                logger.warning("army queue: unknown domain %r", domain)
                await ack(redis_client, ARMY_QUEUE, raw_msg)
                continue
            logger.info("army %s starting (run_id=%s)", domain, payload.get("run_id"))
            await execute_army(
                domain, db_pool, redis_client,
                run_id=payload.get("run_id"),
                run_type=payload.get("run_type", "manual"),
                triggered_by=payload.get("triggered_by"),
                sources=payload.get("sources"),
            )
            await ack(redis_client, ARMY_QUEUE, raw_msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.error("army consumer error: %s", e, exc_info=True)
            try:
                await requeue_or_dlq(redis_client, ARMY_QUEUE, payload, raw_msg)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(5)
