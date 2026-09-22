"""Integration seam: the college enricher must run the free OSINT waterfall
BEFORE any paid provider, must store waterfall hits through the same no-clobber
upsert, and must record the waterfall's SMTP verdicts so addresses verified
during discovery are not re-probed by the generic verify pass.

The enricher is exercised with fake conn/fetch layers; no network, no database.
"""
import pytest

import scrapers.domains.colleges.enrichment as enrichment
from scrapers.domains.contact_waterfall import WaterfallContact


class FakeConn:
    """Captures executed SQL so tests can assert on upsert behaviour."""

    def __init__(self, rows=None):
        self.rows = rows or {}
        self.executed: list[tuple] = []

    async def fetchrow(self, query, *args):
        key = "college" if "FROM colleges" in query else "contact"
        return self.rows.get(key)

    async def fetch(self, query, *args):
        if "SELECT email FROM college_contacts" in query:
            return self.rows.get("emails", [])
        return self.rows.get("fetch", [])

    async def fetchval(self, query, *args):
        return "run-1"

    async def execute(self, query, *args):
        self.executed.append((query.strip()[:80], args))


@pytest.mark.asyncio
async def test_waterfall_runs_before_paid_providers(monkeypatch):
    """The waterfall layer is consulted first; providers are last-resort only."""
    order: list[str] = []

    async def fake_waterfall(website_url, **kw):
        order.append("waterfall")
        return {
            "candidates": [{
                "email": "placements@college.edu", "layer": "role_inbox",
                "confidence": 78, "verified": True, "status": "verified",
                "role_address": True, "evidence": {},
            }],
            "report": {"layers_run": ["role_inbox"], "candidates": 1, "verified": 1, "errors": []},
        }

    async def fake_providers(website_domain=None, limit=10):
        order.append("providers")
        return {"contacts": [], "providers_used": ["hunter"], "errors": []}

    async def fake_record(conn, domain, entity_id, wf):
        order.append("record_verdicts")
        return 1

    monkeypatch.setattr("scrapers.domains.contact_waterfall.run_contact_waterfall", fake_waterfall)
    monkeypatch.setattr(enrichment, "enrich_with_providers", fake_providers, raising=False)
    monkeypatch.setattr("scrapers.domains.providers.enrich_with_providers", fake_providers)
    monkeypatch.setattr("scrapers.domains.verification.record_waterfall_verdicts", fake_record)

    conn = FakeConn({
        "college": {"id": "c1", "name": "College", "website_url": "https://college.edu",
                    "tpo_name": None, "principal_name": None, "is_active": True},
        "emails": [],
    })
    # Skip the page-fetch pass entirely: waterfall must run without pages too.
    async def no_urls(url):
        return []
    monkeypatch.setattr(enrichment.contact_discovery, "discover_contact_urls", no_urls)

    result = await enrichment.enrich_college(conn, "c1", fetch_pages=True)

    assert order[:2] == ["waterfall", "record_verdicts"], "free layer must precede paid"
    assert "providers" not in order, "paid providers must be SKIPPED when the free waterfall delivered"
    assert result["contacts_inserted"] >= 1


@pytest.mark.asyncio
async def test_paid_providers_run_only_when_waterfall_finds_nothing(monkeypatch):
    """The paid tier is a genuine last resort: it fires only on a waterfall miss."""
    order: list[str] = []

    async def empty_waterfall(website_url, **kw):
        order.append("waterfall")
        return {"candidates": [], "report": {"layers_run": [], "candidates": 0, "verified": 0, "errors": []}}

    async def fake_providers(website_domain=None, limit=10):
        order.append("providers")
        return {"contacts": [], "providers_used": ["hunter"], "errors": []}

    monkeypatch.setattr("scrapers.domains.contact_waterfall.run_contact_waterfall", empty_waterfall)
    monkeypatch.setattr("scrapers.domains.providers.enrich_with_providers", fake_providers)

    conn = FakeConn({
        "college": {"id": "c1", "name": "College", "website_url": "https://college.edu",
                    "tpo_name": None, "principal_name": None, "is_active": True},
        "emails": [],
    })
    async def no_urls(url):
        return []
    monkeypatch.setattr(enrichment.contact_discovery, "discover_contact_urls", no_urls)

    await enrichment.enrich_college(conn, "c1", fetch_pages=True)

    assert order == ["waterfall", "providers"], "paid tier runs only after the free one misses"


@pytest.mark.asyncio
async def test_waterfall_hit_stored_with_layer_provenance(monkeypatch):
    """A waterfall hit lands as an osint_waterfall_* sourced contact row."""
    captured: list[dict] = []

    real_upsert = enrichment.upsert_college_contact

    async def spy_upsert(conn, college_id, contact):
        captured.append(contact)
        return True

    async def fake_waterfall(website_url, **kw):
        return {
            "candidates": [{
                "email": "tpo@college.edu", "layer": "role_inbox",
                "confidence": 78, "verified": True, "status": "verified",
                "role_address": True, "evidence": {"smtp_code": 250},
            }],
            "report": {"layers_run": ["role_inbox"], "candidates": 1, "verified": 1, "errors": []},
        }

    monkeypatch.setattr("scrapers.domains.contact_waterfall.run_contact_waterfall", fake_waterfall)
    monkeypatch.setattr(enrichment, "upsert_college_contact", spy_upsert)
    monkeypatch.setattr("scrapers.domains.verification.record_waterfall_verdicts", lambda *a, **k: _noop())

    async def _noop(*a, **k):
        return 0

    conn = FakeConn({
        "college": {"id": "c1", "name": "College", "website_url": "https://college.edu",
                    "tpo_name": None, "principal_name": None},
        "emails": [],
    })
    async def no_urls(url):
        return []
    monkeypatch.setattr(enrichment.contact_discovery, "discover_contact_urls", no_urls)

    await enrichment.enrich_college(conn, "c1", fetch_pages=True)

    wf_rows = [c for c in captured if c.get("contact_source", "").startswith("osint_waterfall_")]
    assert wf_rows, "waterfall candidate must reach the upsert"
    row = wf_rows[0]
    assert row["email"] == "tpo@college.edu"
    assert row["verification_status"] == "verified"
    assert "role_inbox" in row["contact_source"]
    assert row["full_name"] is None, "a shared inbox must never be presented as a person"


@pytest.mark.asyncio
async def test_waterfall_failure_never_fails_enrichment(monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("network gone")

    monkeypatch.setattr("scrapers.domains.contact_waterfall.run_contact_waterfall", boom)

    conn = FakeConn({
        "college": {"id": "c1", "name": "College", "website_url": "https://college.edu",
                    "tpo_name": None, "principal_name": None},
        "emails": [],
    })
    async def no_urls(url):
        return []
    monkeypatch.setattr(enrichment.contact_discovery, "discover_contact_urls", no_urls)

    result = await enrichment.enrich_college(conn, "c1", fetch_pages=True)

    assert result["status"] == "completed"
    assert any("waterfall" in e for e in result["errors"]), "failure is reported, not swallowed"
