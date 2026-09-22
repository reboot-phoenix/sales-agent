"""Source-adapter contract for the hackathon and college domains.

Every public source is implemented as an adapter with a single ``discover()``
entry point. The base class owns everything that must not vary between sources:

  * isolation — one source failing/timing out never aborts the army
  * retry + jittered backoff (bounded)
  * per-source circuit breaker with health persisted to scraper_sources
  * robots/rate-limit politeness (through utils.http_client)
  * durable RAW persistence BEFORE anything downstream sees the record

The last point is the no-lead-loss guarantee: ``run()`` writes each discovered
item to ``raw_discovery_records`` (idempotent by domain+source+checksum) and then
returns the queued raw ids. A parser or normalizer crash cannot lose a discovered
lead because the row is already committed and will be re-processed on the next
run/boot.
"""

from __future__ import annotations

import abc
import asyncio
import hashlib
import json
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from ..base import CircuitBreaker

logger = logging.getLogger(__name__)


class SourceTemporarilyUnavailable(Exception):
    """A source is down/blocked. Recorded as a source-level failure, never raised
    to the caller of run() — one dead site must degrade only itself."""


@dataclass
class RawDiscovery:
    """One discovered, not-yet-normalized item from a public source."""

    source: str
    payload: dict[str, Any]
    source_url: Optional[str] = None
    fetched_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # Set by the caller when the adapter can point at the exact item URL.
    extraction_method: str = "html_parse"

    def checksum(self) -> str:
        """Stable identity for dedup-at-ingest. Prefers the natural key the source
        exposes (url/id), so re-running a source the same day does not duplicate."""
        payload = self.payload or {}
        key_bits = [
            str(payload.get("id") or ""),
            str(payload.get("url") or payload.get("hackathon_url") or ""),
            str(payload.get("source_url") or self.source_url or ""),
            str(payload.get("name") or payload.get("title") or payload.get("college_name") or ""),
            str(payload.get("aishe_code") or ""),
        ]
        if not any(key_bits):
            key_bits.append(json.dumps(payload, sort_keys=True, default=str))
        return hashlib.sha256("|".join(key_bits).encode("utf-8")).hexdigest()


@dataclass
class AdapterResult:
    source: str
    domain: str
    discovered: int = 0
    stored: int = 0
    duplicates: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: int = 0
    unavailable: bool = False


class AdapterRun(tuple):
    """What ``SourceAdapter.run()`` returns: ``(records, result)``.

    A plain 2-tuple (so ``records, result = await adapter.run(...)`` keeps
    working) that also forwards attribute access to the ``AdapterResult``, so a
    caller can read ``run.stored`` / ``run.unavailable`` directly. Both shapes
    are supported on purpose: the orchestrator unpacks, the e2e pipeline tests
    assert on the counters.
    """

    def __new__(cls, records: list["RawDiscovery"], result: AdapterResult):
        return super().__new__(cls, (records, result))

    @property
    def records(self) -> list["RawDiscovery"]:
        return self[0]  # type: ignore[no-any-return]

    @property
    def result(self) -> AdapterResult:
        return self[1]  # type: ignore[no-any-return]

    def __getattr__(self, name: str):
        # Only reached for names not defined here — delegate to the result.
        return getattr(self[1], name)


class SourceAdapter(abc.ABC):
    """Base for one public source in one domain."""

    domain: str = "hackathons"
    name: str = ""
    display_name: str = ""
    tier: int = 3
    enabled_by_default: bool = True
    base_url: Optional[str] = None
    rate_limit_seconds: float = 1.0
    timeout_seconds: float = 90.0
    max_attempts: int = 3
    # Honest statement about what has actually been exercised, surfaced by the
    # /armies/sources endpoint. Never claims external verification that did not
    # happen (see docs/PROGRESS.md).
    verification_note: Optional[str] = None

    def __init__(self, redis_client=None, db=None):
        self._init_state(redis_client, db)

    def _init_state(self, redis_client=None, db=None) -> None:
        """Wire the shared plumbing. Idempotent, so subclasses that skip
        ``super().__init__()`` (test doubles) still behave.

        ``db`` may be a pool, a bare connection, or None. It is used for
        ``persist_raw`` (the no-lead-loss write) and the circuit breaker's
        fallback storage; ``run(db_pool, ...)`` takes its own handle so the two
        never diverge.
        """
        if not hasattr(self, "_redis"):
            self._redis = redis_client
            self._db = db
            self._log = logging.getLogger(f"domain.{self.domain}.{self.name}")
            self.breaker = CircuitBreaker(
                source_name=f"{self.domain}:{self.name}",
                redis_client=redis_client,
                db=db,
            )

    @property
    def log(self) -> logging.Logger:
        """Logger available even when __init__ was bypassed (test doubles)."""
        self._init_state()
        return self._log  # type: ignore[has-type]

    @property
    def db(self):
        """The default DB handle (pool or connection), or None."""
        self._init_state()
        return self._db

    # ------------------------------------------------------------------ metadata
    def source_metadata(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "name": self.name,
            "display_name": self.display_name or self.name,
            "adapter": type(self).__name__,
            "tier": self.tier,
            "enabled_by_default": self.enabled_by_default,
            "base_url": self.base_url,
            "verification_note": self.verification_note,
        }

    # ------------------------------------------------------------------ core
    @abc.abstractmethod
    async def discover(self) -> list[RawDiscovery]:
        """Fetch and parse this source. Raise SourceTemporarilyUnavailable to be
        recorded as a source-level outage rather than a code bug."""

    async def run(self, db_pool=None, run_id: Optional[str] = None) -> AdapterRun:
        """Discover with bounded retries + circuit breaker. Never raises.

        Returns an ``AdapterRun`` (``records, result`` unpackable, attributes
        delegated to the result).

        Durability contract: when ``db_pool`` is given, every discovered item is
        persisted to ``raw_discovery_records`` INSIDE this call, before the
        caller can possibly crash, and the source's health is recorded. So even
        an orchestrator that dies between ``run()`` returning and its own book-
        keeping cannot lose a discovered lead. Callers without a db (tests) get
        the records back unpersisted, exactly as before.
        """
        started = time.monotonic()
        result = AdapterResult(source=self.name, domain=self.domain)
        if await self._breaker_open():
            result.unavailable = True
            result.errors.append("circuit_open")
            result.duration_ms = int((time.monotonic() - started) * 1000)
            self.log.warning("Circuit breaker open; skipping %s", self.name)
            return AdapterRun([], result)

        last_err: Optional[Exception] = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                records = await asyncio.wait_for(self.discover(), timeout=self.timeout_seconds)
                await self._record_health(success=True)
                result.discovered = len(records)
                result.duration_ms = int((time.monotonic() - started) * 1000)
                if db_pool is not None:
                    result.stored, result.duplicates = await self.persist_raw(records, run_id=run_id, db=db_pool)
                    await self._record_source_health(db_pool, result)
                return AdapterRun(records, result)
            except SourceTemporarilyUnavailable as e:
                last_err = e
                self.log.warning("%s temporarily unavailable: %s", self.name, e)
                if attempt >= self.max_attempts:
                    break
            except asyncio.TimeoutError as e:  # noqa: PERF203
                last_err = e
                self.log.warning("%s timed out after %.0fs (attempt %d)", self.name, self.timeout_seconds, attempt)
            except Exception as e:  # noqa: BLE001 - isolation is the point
                last_err = e
                self.log.warning("%s failed (attempt %d): %s", self.name, attempt, e)
            if attempt < self.max_attempts:
                await asyncio.sleep(self._backoff(attempt))

        result.unavailable = True
        result.errors.append(str(last_err)[:500] if last_err else "unknown")
        result.duration_ms = int((time.monotonic() - started) * 1000)
        await self._record_health(success=False, reason=str(last_err)[:500] if last_err else "unknown")
        if db_pool is not None:
            await self._record_source_health(db_pool, result)
        return AdapterRun([], result)

    async def _record_source_health(self, db_pool, result: AdapterResult) -> None:
        """Persist per-source health from inside run(); best-effort by design."""
        try:
            from .armies import record_source_health
            async with db_pool.acquire() as conn:
                await record_source_health(conn, self.domain, self, result)
        except Exception as e:  # noqa: BLE001
            self._log.debug("source health persist failed: %s", e)

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(10.0, 2 ** attempt) * random.uniform(0.5, 1.5)

    async def _breaker_open(self) -> bool:
        try:
            breaker = getattr(self, "breaker", None)
            if breaker is None:
                self._init_state()
                breaker = self.breaker
            return await breaker.is_open_async()
        except Exception:  # noqa: BLE001
            try:
                return self.breaker.is_open()
            except Exception:  # noqa: BLE001 - a broken breaker must not fail the source
                return False

    async def _record_health(self, success: bool, reason: Optional[str] = None) -> None:
        try:
            self._init_state()
            if success:
                await self.breaker.record_success_async()
            else:
                await self.breaker.record_failure_async(reason or "failure")
        except Exception as e:  # noqa: BLE001
            self.log.debug("health update failed: %s", e)

    # ------------------------------------------------------------------ durable raw
    async def persist_raw(
        self,
        records: list[RawDiscovery],
        run_id: Optional[str] = None,
        db=None,
    ) -> tuple[int, int]:
        """Write discovered items to ``raw_discovery_records``.

        Idempotent by (domain, source, checksum): a duplicate re-discovery within a
        run reconciles to a no-op and is counted, not re-inserted.

        ``db`` accepts a pool (``acquire()``) or a bare connection (``execute()``);
        when omitted the adapter's own handle is used. Without any handle this
        returns (0, 0) and the caller decides whether in-memory processing is
        acceptable (tests).
        """
        handle = db if db is not None else self.db
        if handle is None or not records:
            return 0, 0
        stored = 0
        duplicates = 0
        for rec in records:
            try:
                fetched = rec.fetched_at
                if isinstance(fetched, str):
                    from datetime import datetime as _dt
                    try:
                        fetched = _dt.fromisoformat(fetched)
                    except ValueError:
                        pass
                status = await self._execute_on(handle,
                    """
                    INSERT INTO raw_discovery_records
                      (run_id, domain, source, source_url, checksum, payload, status, fetched_at)
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'stored', $7)
                    ON CONFLICT (domain, source, checksum) DO NOTHING
                    """,
                    run_id, self.domain, self.name, rec.source_url, rec.checksum(),
                    json.dumps(rec.payload, default=str), fetched,
                )
                if str(status).endswith(" 1"):
                    stored += 1
                else:
                    duplicates += 1
            except Exception as e:  # noqa: BLE001
                self.log.warning("raw persist failed for %s: %s", self.name, e)
        return stored, duplicates

    @staticmethod
    async def _execute_on(handle, sql: str, *args):
        """Run one statement through a pool or a bare connection."""
        acquire = getattr(handle, "acquire", None)
        if acquire is None:
            return await handle.execute(sql, *args)
        async with acquire() as conn:
            return await conn.execute(sql, *args)
