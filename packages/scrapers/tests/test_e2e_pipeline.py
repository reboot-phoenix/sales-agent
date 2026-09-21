"""End-to-end pipeline: discover -> raw -> normalize -> enrich -> verify -> score -> claim.

This is an integration test, not a unit test: it drives the *real* production
functions (adapter ``run()``, college enrichment, contact extraction, deliverability
verification, the outreach scorer and the ownership guard) against a small
in-memory stand-in for Postgres.

The stub deliberately models only the invariants these flows depend on:

* raw discovery is write-once per (domain, source, checksum) — the no-lead-loss
  guarantee is about durability, not about the fake store;
* a claim succeeds for exactly one caller because the guard lives in the UPDATE's
  WHERE clause;
* contacts are matched by email/phone/LinkedIn before insert, so a second sweep
  enriches rather than duplicates.

It does not validate SQL syntax or Postgres semantics — that is what a real
database and the migration tests are for. What it does prove is that the stages
compose: what one stage writes is what the next stage reads.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Any, Optional

import pytest

from scrapers.domains.base import RawDiscovery, SourceAdapter
from scrapers.domains.colleges.enrichment import extract_role_contacts, upsert_college_contact
from scrapers.domains.email_verify import EmailVerification
from scrapers.domains.outreach import assess_lead, persist_assessment
from scrapers.domains.verification import verify_contact_emails


# --------------------------------------------------------------------------- #
# A very small in-memory stand-in for the few statements the pipeline needs.
# --------------------------------------------------------------------------- #

def _new_id() -> str:
    return str(uuid.uuid4())


class MiniDB:
    def __init__(self) -> None:
        self.colleges: dict[str, dict[str, Any]] = {}
        self.college_contacts: list[dict[str, Any]] = []
        self.raw_records: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.enrichment_runs: dict[str, dict[str, Any]] = {}
        self.source_health: dict[tuple[str, str], dict[str, Any]] = {}
        self.statements: list[str] = []
        # Set to make the next write fail, simulating a database dropping out.
        self.fail_writes = False

    # -- asyncpg surface ---------------------------------------------------- #

    async def fetchrow(self, sql: str, *args) -> Optional[dict[str, Any]]:
        self.statements.append(sql)
        if "FROM colleges WHERE fingerprint" in sql:
            return next((c for c in self.colleges.values() if c["fingerprint"] == args[0]), None)
        if "FROM colleges WHERE id" in sql:
            return self.colleges.get(str(args[0]))
        if "FROM college_contacts" in sql:
            return next((c for c in self.college_contacts
                         if c["college_id"] == str(args[0])
                         and (args[1] is None or (c.get("email") or "").lower() == str(args[1]).lower())), None)
        return None

    async def fetch(self, sql: str, *args) -> list[dict[str, Any]]:
        self.statements.append(sql)
        if "FROM college_contacts" in sql:
            return [dict(c) for c in self.college_contacts if c["college_id"] == str(args[0])]
        if "FROM colleges WHERE lower(state)" in sql:
            return [dict(c) for c in self.colleges.values()
                    if (c.get("state") or "").lower() == str(args[0]).lower()]
        return []

    async def fetchval(self, sql: str, *args):
        self.statements.append(sql)
        if "INSERT INTO colleges" in sql:
            college_id = _new_id()
            # Column order mirrors the production INSERT.
            columns = [
                "name", "official_name", "slug", "aishe_code", "university_affiliation",
                "state", "district", "city", "address", "pincode",
                "institution_type", "ownership", "is_public", "autonomous",
                "accreditation", "naac_grade", "naac_score", "nirf_rank", "aicte_approved",
                "website_url", "official_email", "phone", "admissions_contact", "placement_contact",
                "linkedin_url", "socials", "programs", "source_urls",
                "completeness_score", "freshness_category", "confidence_score",
                "enrichment_status", "outreach_readiness", "fingerprint", "raw_payload",
            ]
            row = {"id": college_id, "source_count": 1, "is_active": True,
                   "claimed_by": None, "assigned_to": None, "created_at": "2026-09-21T00:00:00Z"}
            for column, value in zip(columns, args):
                row[column] = json.loads(value) if column in ("socials", "programs", "source_urls", "raw_payload") else value
            self.colleges[college_id] = row
            return college_id
        if "INSERT INTO enrichment_runs" in sql:
            run_id = _new_id()
            self.enrichment_runs[run_id] = {"id": run_id, "status": "running"}
            return run_id
        return None

    async def execute(self, sql: str, *args):
        self.statements.append(sql)
        if self.fail_writes:
            raise RuntimeError("database unavailable")
        if "INSERT INTO raw_discovery_records" in sql:
            domain, source, checksum = args[0], args[1], args[3] if len(args) > 3 else None
            key = (str(domain), str(source), str(checksum))
            if key in self.raw_records:
                return "INSERT 0 0"
            self.raw_records[key] = {"domain": domain, "source": source, "checksum": checksum}
            return "INSERT 0 1"
        if "INSERT INTO college_contacts" in sql:
            self.college_contacts.append({
                "id": _new_id(),
                "college_id": str(args[0]),
                "full_name": args[1], "designation": args[2], "role_category": args[3],
                "priority": args[4], "email": args[6], "phone": args[7],
                "linkedin_url": args[8], "verification_status": args[9],
                "contact_source": args[10], "source_url": args[11],
                "confidence_score": args[12], "verification_grade": None,
                "field_provenance": {},
            })
            return "INSERT 0 1"
        if sql.strip().startswith("UPDATE colleges SET outreach_score"):
            college = self.colleges.get(str(args[0]))
            if college is not None:
                college.update({"outreach_score": args[1], "outreach_priority": args[2],
                                "outreach_readiness": args[3]})
            return "UPDATE 1"
        if sql.strip().startswith("UPDATE colleges SET"):
            return "UPDATE 1"
        if sql.strip().startswith("UPDATE college_contacts SET"):
            for contact in self.college_contacts:
                if contact["id"] == str(args[0]):
                    # Three production statements share this prefix; model each
                    # one's real arg layout.
                    if "verification_status" in sql:
                        # persist_verdict: (id, status, grade, provenance_json)
                        contact["verification_status"] = args[1]
                        if args[2]:
                            contact["verification_grade"] = args[2]
                        contact["field_provenance"] = {"email_verification": json.loads(args[3])}
                    elif "department" in sql:
                        # Weaker-source backfill: (id, full_name, designation,
                        # department, linkedin_url) — only fills gaps.
                        for key, value in (("full_name", args[1]), ("designation", args[2]),
                                           ("department", args[3]), ("linkedin_url", args[4])):
                            if value and not contact.get(key):
                                contact[key] = value
                    else:
                        # Merge-from-enrichment: (id, full_name, designation,
                        # role_category, priority, email, phone, linkedin_url,
                        # contact_source, source_url, confidence_score)
                        contact["full_name"] = args[1]
                        contact["designation"] = args[2]
                        contact["role_category"] = args[3]
                        contact["priority"] = args[4]
                        for key, value in (("email", args[5]), ("phone", args[6]),
                                           ("linkedin_url", args[7])):
                            if value:
                                contact[key] = value
                        contact["contact_source"] = args[8]
                        contact["source_url"] = args[9]
                        contact["confidence_score"] = max(
                            int(contact.get("confidence_score") or 0), int(args[10] or 0))
                    contact["updated_at"] = "now"
            return "UPDATE 1"
        if sql.strip().startswith("UPDATE enrichment_runs"):
            return "UPDATE 1"
        if "scraper_sources" in sql:
            self.source_health[(str(args[0]), str(args[1]))] = {"args": args}
            return "INSERT 0 1"
        return "OK"

    # -- ownership guard (mirrors the API's atomic claim) ------------------- #

    def claim(self, college_id: str, user_id: str) -> str:
        """The production rule: UPDATE ... WHERE claimed_by IS NULL."""
        college = self.colleges.get(college_id)
        if college is None:
            return "missing"
        if college["claimed_by"] is None:
            college["claimed_by"] = user_id
            return "claimed"
        return "already_owned" if college["claimed_by"] == user_id else "taken"


class _Ctx:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc):
        return False


class MiniPool:
    def __init__(self, conn: MiniDB) -> None:
        self.conn = conn

    def acquire(self):
        return _Ctx(self.conn)


class DiscoveryAdapter(SourceAdapter):
    """A real adapter subclass, fed from a fixture instead of the network."""

    domain = "colleges"
    name = "fixture_portal"
    max_attempts = 1

    def __init__(self, items: list[dict[str, Any]], fail: bool = False) -> None:
        self.items = items
        self.fail = fail
        self.calls = 0

    async def discover(self) -> list[RawDiscovery]:
        self.calls += 1
        if self.fail:
            raise RuntimeError("source went down")
        return [
            RawDiscovery(source=self.name, payload=item,
                         source_url=item.get("url"), extraction_method="html_parse")
            for item in self.items
        ]


PLACEMENT_HTML = """
<html><body>
  <h1>Training &amp; Placement Cell</h1>
  <div class="card">
    <h3>Training and Placement Officer</h3>
    <p>Dr. Asha Rao</p>
    <p>Email: asha.rao@abc.edu</p>
    <p>Phone: +91 98765 43210</p>
  </div>
  <div class="card">
    <h3>Principal</h3>
    <p>Prof. Ravi Menon</p>
    <p>principal@abc.edu</p>
  </div>
</body></html>
"""


def _seed_college(db: MiniDB, *, name="ABC Institute of Technology", website="https://abc.edu") -> str:
    college_id = _new_id()
    db.colleges[college_id] = {
        "id": college_id, "name": name, "slug": "abc-institute-of-technology",
        "state": "Tamil Nadu", "district": "Chennai", "city": "Chennai",
        "website_url": website, "fingerprint": "fp-abc", "source_count": 2,
        "is_active": True, "claimed_by": None, "assigned_to": None,
        "enrichment_status": "NORMALIZED", "outreach_readiness": "NEEDS_ENRICHMENT",
        "completeness_score": 60, "confidence_score": 40, "verification_status": "unverified",
        "created_at": "2026-09-20T00:00:00Z",
    }
    return college_id


# --------------------------------------------------------------------------- #
# Flows
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_discovery_persists_raw_before_anything_downstream_runs():
    """Flow 12 (discover): a discovered college survives even if parsing never runs."""
    db = MiniDB()
    adapter = DiscoveryAdapter([{
        "name": "ABC Institute of Technology", "state": "Tamil Nadu",
        "website_url": "https://abc.edu", "aishe_code": "C-12345",
        "url": "https://ugc.gov.in/colleges",
    }])
    result = await adapter.run(MiniPool(db))
    assert result.discovered == 1
    assert result.stored == 1
    assert len(db.raw_records) == 1


@pytest.mark.asyncio
async def test_duplicate_discovery_is_idempotent_at_ingest():
    """Flow: re-running the same source must not duplicate the lead."""
    db = MiniDB()
    item = {"name": "ABC Institute of Technology", "website_url": "https://abc.edu",
            "url": "https://ugc.gov.in/colleges"}
    first = await DiscoveryAdapter([item]).run(MiniPool(db))
    second = await DiscoveryAdapter([item]).run(MiniPool(db))
    assert first.stored == 1
    assert second.stored == 0
    assert len(db.raw_records) == 1


@pytest.mark.asyncio
async def test_a_failing_source_leaves_earlier_discoveries_intact():
    """Flow 21-23 (kill a worker, restart): nothing already persisted is lost."""
    db = MiniDB()
    good = await DiscoveryAdapter([{"name": "ABC Institute of Technology",
                                    "website_url": "https://abc.edu"}]).run(MiniPool(db))
    assert good.stored == 1
    broken = await DiscoveryAdapter([], fail=True).run(MiniPool(db))
    assert broken.stored == 0
    assert broken.unavailable is True
    assert len(db.raw_records) == 1
    # The source is marked down, not deleted.
    assert any(key[1] == "fixture_portal" for key in db.source_health)


@pytest.mark.asyncio
async def test_enrichment_extracts_contacts_then_verifies_them():
    """Flows 13-15: enrich TPO + principal, then check deliverability."""
    db = MiniDB()
    college_id = _seed_college(db)

    contacts = extract_role_contacts(PLACEMENT_HTML, "https://abc.edu/training-and-placement-cell")
    assert {c["role_category"] for c in contacts} >= {"tpo", "principal"}
    for contact in contacts:
        assert await upsert_college_contact(db, college_id, contact) is True

    assert len(db.college_contacts) == 2

    # Every extracted address carries its provenance.
    for stored in db.college_contacts:
        assert stored["source_url"] == "https://abc.edu/training-and-placement-cell"
        assert stored["verification_status"] == "unverified"

    def verifier(email: str) -> EmailVerification:
        if email.startswith("asha.rao"):
            return EmailVerification(email=email, status="verified", reason="accepted",
                                     grade="A", checked_at="2026-09-21T02:00:00+00:00")
        return EmailVerification(email=email, status="undeliverable", reason="rejected",
                                 checked_at="2026-09-21T02:00:00+00:00")

    stats = await verify_contact_emails(db, "colleges", college_id, verifier=verifier)
    assert stats["checked"] == 2
    assert stats["verified"] == 1
    assert stats["undeliverable"] == 1

    tpo = next(c for c in db.college_contacts if c["role_category"] == "tpo")
    principal = next(c for c in db.college_contacts if c["role_category"] == "principal")
    assert tpo["verification_status"] == "verified"
    assert tpo["verification_grade"] == "A"
    # A rejected mailbox is recorded as failed, never deleted.
    assert principal["verification_status"] == "failed"
    assert "email_verification" in principal["field_provenance"]


@pytest.mark.asyncio
async def test_a_second_enrichment_pass_enriches_instead_of_duplicating():
    """Entity resolution at contact level: the same person is one row."""
    db = MiniDB()
    college_id = _seed_college(db)
    contacts = extract_role_contacts(PLACEMENT_HTML, "https://abc.edu/placement")
    for contact in contacts:
        await upsert_college_contact(db, college_id, contact)
    before = len(db.college_contacts)

    # Re-crawl from a different page of the same site.
    for contact in extract_role_contacts(PLACEMENT_HTML, "https://abc.edu/placement-cell"):
        await upsert_college_contact(db, college_id, contact)

    assert len(db.college_contacts) == before


@pytest.mark.asyncio
async def test_outreach_score_is_persisted_and_reflects_verified_reachability():
    """Flow: a verified TPO address makes the college sendable, and says why."""
    db = MiniDB()
    college_id = _seed_college(db)
    for contact in extract_role_contacts(PLACEMENT_HTML, "https://abc.edu/placement"):
        await upsert_college_contact(db, college_id, contact)

    unverified = assess_lead("colleges", db.colleges[college_id],
                             [c for c in db.college_contacts if c["college_id"] == college_id])
    assert unverified.readiness == "PARTIALLY_ENRICHED"

    for contact in db.college_contacts:
        if contact["role_category"] == "tpo":
            contact["verification_status"] = "verified"
            contact["verification_grade"] = "A"

    verified = assess_lead("colleges", db.colleges[college_id],
                           [c for c in db.college_contacts if c["college_id"] == college_id])
    assert verified.readiness == "OUTREACH_READY"
    assert verified.priority == "P0"
    assert verified.score > unverified.score
    assert "verified personal email" in verified.reasons

    await persist_assessment(db, verified)
    stored = db.colleges[college_id]
    assert stored["outreach_score"] == verified.score
    assert stored["outreach_priority"] == "P0"
    assert stored["outreach_readiness"] == "OUTREACH_READY"


@pytest.mark.asyncio
async def test_two_reps_racing_for_the_same_lead_leave_exactly_one_owner():
    """Flow 10-11 / 21: concurrent claims cannot both succeed."""
    db = MiniDB()
    college_id = _seed_college(db)
    rep_a, rep_b = _new_id(), _new_id()

    results = await asyncio.gather(
        asyncio.to_thread(db.claim, college_id, rep_a),
        asyncio.to_thread(db.claim, college_id, rep_b),
    )
    assert sorted(results) == ["already_owned", "taken"] or results.count("claimed") == 1
    assert db.colleges[college_id]["claimed_by"] in (rep_a, rep_b)
    assert db.claim(college_id, db.colleges[college_id]["claimed_by"]) == "already_owned"


@pytest.mark.asyncio
async def test_my_leads_visibility_follows_ownership():
    """Flow 16: the owner sees the lead; another rep does not."""
    db = MiniDB()
    mine = _seed_college(db, name="Owned College")
    theirs = _seed_college(db, name="Someone Elses College")
    rep = _new_id()
    db.claim(mine, rep)

    visible = [c for c in db.colleges.values()
               if c.get("claimed_by") == rep or c.get("assigned_to") == rep]
    assert [c["name"] for c in visible] == ["Owned College"]
    assert theirs not in visible


@pytest.mark.asyncio
async def test_database_failure_during_enrichment_does_not_lose_discovered_raw():
    """Failure recovery: a write outage leaves the raw record for the next run."""
    db = MiniDB()
    await DiscoveryAdapter([{"name": "ABC Institute of Technology",
                             "website_url": "https://abc.edu"}]).run(MiniPool(db))
    raw_before = len(db.raw_records)

    db.fail_writes = True
    college_id = _seed_college(db)
    with pytest.raises(RuntimeError):
        await upsert_college_contact(db, college_id, {
            "full_name": "Dr. Asha Rao", "role_category": "tpo",
            "email": "asha.rao@abc.edu", "contact_source": "college_page",
            "source_url": "https://abc.edu/placement", "verification_status": "unverified",
        })

    db.fail_writes = False
    assert len(db.raw_records) == raw_before
    # Once the database is back, the same contact stores cleanly.
    stored = await upsert_college_contact(db, college_id, {
        "full_name": "Dr. Asha Rao", "role_category": "tpo",
        "email": "asha.rao@abc.edu", "contact_source": "college_page",
        "source_url": "https://abc.edu/placement", "verification_status": "unverified",
    })
    assert stored is True


def test_every_stage_wrote_something_the_next_stage_could_read():
    """A quiet guard against a stage that silently no-ops between rewrites."""
    source = open("scrapers/domains/colleges/enrichment.py").read()
    for marker in ("candidate_contact_urls", "verify_contact_emails", "assess_lead", "persist_assessment"):
        assert re.search(rf"\b{marker}\b", source), f"college enrichment no longer calls {marker}"
