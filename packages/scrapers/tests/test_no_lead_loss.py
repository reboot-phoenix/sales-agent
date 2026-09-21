"""No-lead-loss guarantees.

Discovered items are persisted to raw_discovery_records BEFORE anything
downstream runs, dedup is idempotent, and a stalled 'processing' row is
recoverable. A failing source is isolated, never fatal.
"""
import uuid

import pytest

from scrapers.domains.base import RawDiscovery, SourceAdapter
from scrapers.domains.armies import adapter_registry, adapters_for, reclaim_stalled_raw, update_run

# Marks are applied per-test rather than module-wide so the sync tests below
# are not mislabelled as coroutines.


class _Ctx:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, status="INSERT 0 1"):
        self.status = status
        self.queries: list[tuple] = []

    async def execute(self, query, *args):
        self.queries.append((query, args))
        return self.status


class FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Ctx(self.conn)


class BoomAdapter(SourceAdapter):
    domain = "hackathons"
    name = "boom"
    max_attempts = 1

    async def discover(self):
        raise RuntimeError("kaboom")


class OkAdapter(SourceAdapter):
    domain = "hackathons"
    name = "ok"
    max_attempts = 1

    async def discover(self):
        return [RawDiscovery(source=self.name, payload={"name": "Good Hack", "id": "1"})]


@pytest.mark.asyncio
async def test_failing_source_is_isolated_never_raises():
    records, result = await BoomAdapter().run()
    assert records == []
    assert result.unavailable is True
    assert result.errors
    # The army continues: a sibling source still returns its records.
    good_records, good_result = await OkAdapter().run()
    assert len(good_records) == 1 and good_result.unavailable is False


@pytest.mark.asyncio
async def test_persist_raw_is_idempotent_by_checksum():
    conn = FakeConn()
    adapter = OkAdapter(db=conn)
    record = RawDiscovery(source=adapter.name, payload={"name": "Good Hack", "id": "1"})
    stored, duplicates = await adapter.persist_raw([record], run_id=str(uuid.uuid4()))
    assert stored == 1 and duplicates == 0

    # Second insert of the same record hits the unique constraint -> duplicate.
    conn.status = "INSERT 0 0"
    stored2, duplicates2 = await adapter.persist_raw([record])
    assert stored2 == 0 and duplicates2 == 1
    # Two separate writes, both durable statements.
    assert len(conn.queries) == 2
    assert "raw_discovery_records" in conn.queries[0][0]


@pytest.mark.asyncio
async def test_persist_raw_without_db_returns_zero_not_crash():
    adapter = OkAdapter(db=None)
    stored, duplicates = await adapter.persist_raw([RawDiscovery(source="ok", payload={"name": "x"})])
    assert (stored, duplicates) == (0, 0)


def test_raw_checksum_is_stable_for_the_same_item():
    r1 = RawDiscovery(source="devpost", payload={"id": "1", "url": "https://x/1"})
    r2 = RawDiscovery(source="devpost", payload={"url": "https://x/1", "id": "1"})
    assert r1.checksum() == r2.checksum()
    r3 = RawDiscovery(source="devpost", payload={"id": "2", "url": "https://x/2"})
    assert r3.checksum() != r1.checksum()


@pytest.mark.asyncio
async def test_reclaim_stalled_processing_rows():
    conn = FakeConn(status="UPDATE 3")
    count = await reclaim_stalled_raw(FakePool(conn), domain="hackathons")
    assert count == 3
    query, args = conn.queries[0]
    assert "processing" in query and "stored" in query
    assert args[-1] == "hackathons"


@pytest.mark.asyncio
async def test_update_run_whitelist_ignores_unknown_fields():
    conn = FakeConn(status="UPDATE 1")
    await update_run(FakePool(conn), str(uuid.uuid4()), status="completed", errors_count=2,
                     notes="must be ignored")
    query = conn.queries[0][0]
    assert "status=" in query and "errors_count=" in query
    assert "notes" not in query


def test_adapter_registry_exposes_both_domains():
    registry = adapter_registry()
    assert set(registry) == {"hackathons", "colleges"}
    assert len(registry["hackathons"]) >= 4
    assert len(registry["colleges"]) >= 4
    instances = adapters_for("hackathons")
    assert instances and all(hasattr(a, "discover") for a in instances)
    # `only=` filters by source name so one army can target a subset.
    filtered = adapters_for("hackathons", only=["devpost"])
    assert len(filtered) == 1 and filtered[0].name == "devpost"
