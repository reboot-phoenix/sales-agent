"""
Army stop: cooperative halt for a running fleet + queued jobs.

Stop semantics (what the operator is promised in the confirm dialog):
- in-flight sources are cancelled promptly (bounded by one 5s poll tick);
  already-scraped leads are kept, never discarded;
- queued scrape jobs are skipped, not run;
- the halt flag auto-expires (TTL) so future scheduled runs are unaffected.
"""
import asyncio

import pytest

from scrapers.scrape_consumer import (
    HALT_KEY,
    halt_requested,
    scrape_all_sources,
)

pytestmark = pytest.mark.asyncio


class FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.deleted: list[str] = []

    async def exists(self, key):
        return 1 if key in self.store else 0

    async def set(self, key, value, ex=None):
        self.store[key] = value
        return True

    async def delete(self, key):
        self.deleted.append(key
)
        self.store.pop(key, None)
        return 1


async def test_halt_not_requested_by_default():
    assert await halt_requested(FakeRedis()) is False


async def test_halt_requested_when_flag_set():
    r = FakeRedis()
    await r.set(HALT_KEY, "1")
    assert await halt_requested(r) is True


async def test_halt_check_fail_closed_on_redis_error():
    class DeadRedis:
        async def exists(self, key):
            raise ConnectionError("redis down")

    # A dead Redis must NOT read as "halt" (that would cancel every run
    # whenever the cache blips). Fail-closed = keep running.
    assert await halt_requested(DeadRedis()) is False


async def test_scrape_all_runs_everything_without_halt():
    r = FakeRedis()
    seen: list[str] = []

    async def fake_scrape(src):
        seen.append(src)

    stopped = await scrape_all_sources(["a", "b", "c"], fake_scrape, r)
    assert stopped is False
    assert sorted(seen) == ["a", "b", "c"]


async def test_scrape_all_cancels_pending_on_halt():
    r = FakeRedis()
    started: list[str] = []
    release = asyncio.Event()

    async def fake_scrape(src):
        started.append(src)
        if src == "slow":
            await release.wait()  # stays in-flight until the test frees it
        return None

    task = asyncio.create_task(scrape_all_sources(["fast", "slow"], fake_scrape, r))
    # Let both sources start, then halt while "slow" is still in flight.
    for _ in range(100):
        if len(started) >= 2:
            break
        await asyncio.sleep(0.01)
    await r.set(HALT_KEY, "1")
    stopped = await asyncio.wait_for(task, timeout=15)
    release.set()
    assert stopped is True
    assert "fast" in started and "slow" in started
