"""Automatic re-enrichment: selection, bounds, cooldown and per-entity isolation."""
import pytest

from scrapers.domains import reenrich


class FakeConn:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.queries: list[tuple] = []

    async def fetch(self, query, *args):
        self.queries.append((query, args))
        return self.rows


def test_candidate_sql_targets_contactless_unverified_stale_rows_with_a_cooldown():
    sql = reenrich._candidate_sql("colleges")
    assert "FROM colleges t" in sql
    assert "contact_email IS NULL AND t.contact_phone IS NULL AND t.contact_linkedin IS NULL" in sql
    assert "outreach_readiness IN ('NEEDS_ENRICHMENT', 'INSUFFICIENT_DATA')" in sql
    assert "freshness_category = 'stale'" in sql
    assert "NOT EXISTS" in sql and "enrichment_runs" in sql
    assert "INTERVAL '6 hours'" in sql
    # Upcoming events are worked first; institutions by completeness.
    hack = reenrich._candidate_sql("hackathons")
    assert "registration_deadline >= NOW()" in hack
    assert "completeness_score DESC" in sql


def test_unknown_domain_is_rejected_before_any_sql():
    with pytest.raises(ValueError):
        reenrich._candidate_sql("jobs")
    assert reenrich._clamp(5) == 5
    assert reenrich._clamp(10 ** 6) == reenrich.MAX_LIMIT
    assert reenrich._clamp("nonsense") == 25


@pytest.mark.asyncio
async def test_select_candidates_clamps_the_limit_and_returns_dicts():
    conn = FakeConn(rows=[{"id": "c1", "name": "ABC College"}])
    rows = await reenrich.select_reenrichment_candidates(conn, "colleges", 10 ** 6)
    assert rows == [{"id": "c1", "name": "ABC College"}]
    assert conn.queries[0][1] == (reenrich.MAX_LIMIT,)


@pytest.mark.asyncio
async def test_sweep_isolates_entity_failures_and_reports_them():
    conn = FakeConn(rows=[{"id": "c1"}, {"id": "c2"}, {"id": "c3"}])
    calls: list[str] = []

    async def enricher(_conn, entity_id, **kwargs):
        calls.append(entity_id)
        if entity_id == "c2":
            raise RuntimeError("site down")
        if entity_id == "c3":
            return {"status": "not_found"}
        return {"status": "completed", "contacts_inserted": 2, "readiness": "OUTREACH_READY"}

    report = await reenrich.run_reenrichment_sweep(conn, "colleges", limit=10, enrich_one=enricher)

    assert calls == ["c1", "c2", "c3"]  # a failure never stops the sweep
    assert report["candidates"] == 3
    assert report["attempted"] == 3
    assert report["enriched"] == 1
    assert report["contacts_inserted"] == 2
    assert {e["entity_id"] for e in report["errors"]} == {"c2", "c3"}
    assert "site down" in report["errors"][0]["error"]


@pytest.mark.asyncio
async def test_sweep_records_entities_that_found_nothing_as_not_enriched():
    conn = FakeConn(rows=[{"id": "c1"}])

    async def enricher(_conn, entity_id, **kwargs):
        return {"status": "completed", "contacts_inserted": 0}

    report = await reenrich.run_reenrichment_sweep(conn, "hackathons", enrich_one=enricher)
    assert report["attempted"] == 1
    assert report["enriched"] == 0
    assert report["errors"] == []


@pytest.mark.asyncio
async def test_default_enricher_resolves_per_domain():
    assert reenrich._default_enricher("colleges").__name__ == "enrich_college"
    assert reenrich._default_enricher("hackathons").__name__ == "enrich_hackathon_by_id"
    with pytest.raises(ValueError):
        reenrich._default_enricher("jobs")


@pytest.mark.asyncio
async def test_run_all_without_a_database_is_a_clear_error_not_a_crash():
    assert await reenrich.run_all_reenrichment(None) == {"error": "no_database"}


@pytest.mark.asyncio
async def test_run_all_sweeps_every_domain_independently(monkeypatch):
    seen: list[str] = []

    async def fake_sweep(conn, domain, **kwargs):
        seen.append(domain)
        if domain == "colleges":
            raise RuntimeError("boom")
        return {"domain": domain, "attempted": 0, "enriched": 0, "contacts_inserted": 0, "errors": []}

    monkeypatch.setattr(reenrich, "run_reenrichment_sweep", fake_sweep)

    class Pool:
        def acquire(self):
            class Ctx:
                async def __aenter__(self_inner):
                    return FakeConn()

                async def __aexit__(self_inner, *exc):
                    return False

            return Ctx()

    reports = await reenrich.run_all_reenrichment(Pool(), limit=5)
    assert seen == ["hackathons", "colleges"]
    assert reports["hackathons"]["domain"] == "hackathons"
    assert "boom" in reports["colleges"]["error"]
