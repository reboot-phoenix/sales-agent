"""Storing deliverability verdicts: never downgrade silently, never delete.

The persistence rules matter as much as the verdicts: a re-check must record why
the state changed, a hard rejection must survive as audit evidence, and a verifier
fault must be reported as a skip rather than as proof that a mailbox is bad.
"""
import pytest

from scrapers.domains import verification as vf
from scrapers.domains.email_verify import EmailVerification


def verdict(email, status, grade=None):
    return EmailVerification(
        email=email, status=status, reason=f"test {status}", grade=grade,
        checked_at="2026-09-21T02:00:00+00:00",
    )


class FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.executed: list[tuple[str, tuple]] = []

    async def fetch(self, sql, *args):
        self.sql = sql
        return self.rows

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        return "UPDATE 1"


def test_unknown_domain_is_rejected():
    with pytest.raises(ValueError):
        vf._sql_table("universities")


@pytest.mark.asyncio
async def test_persist_refuses_an_unexpected_table():
    conn = FakeConn([])
    with pytest.raises(ValueError):
        await vf.persist_verdict(conn, "users", "id", verdict("a@b.edu", "verified"))


@pytest.mark.asyncio
async def test_verified_verdict_sets_status_and_grade():
    conn = FakeConn([])
    await vf.persist_verdict(conn, "college_contacts", "c1", verdict("tpo@x.edu", "verified", "B"))
    sql, args = conn.executed[0]
    assert "verification_status = $2" in sql
    assert args[1] == "verified"
    assert args[2] == "B"
    # The verdict is stored as per-field provenance, not just a status flag.
    assert "jsonb_build_object('email_verification'" in sql
    assert "\"status\": \"verified\"" in args[3]


@pytest.mark.asyncio
async def test_undeliverable_keeps_the_row_and_clears_the_grade():
    conn = FakeConn([])
    await vf.persist_verdict(conn, "college_contacts", "c1", verdict("gone@x.edu", "undeliverable"))
    _, args = conn.executed[0]
    assert args[1] == "failed"
    assert args[2] is None
    # The verdict itself is still written down, so the rejection is auditable.
    assert "undeliverable" in args[3]


@pytest.mark.asyncio
async def test_catch_all_is_partially_verified_not_verified():
    conn = FakeConn([])
    await vf.persist_verdict(conn, "college_contacts", "c1", verdict("tpo@x.edu", "catch_all", "C"))
    _, args = conn.executed[0]
    assert args[1] == "partially_verified"


@pytest.mark.asyncio
async def test_verify_contact_emails_records_stats_and_uses_injected_verifier():
    rows = [
        {"id": "1", "email": "tpo@x.edu", "verification_status": "unverified"},
        {"id": "2", "email": "gone@x.edu", "verification_status": "unverified"},
        {"id": "3", "email": "old@x.edu", "verification_status": "verified"},
    ]
    conn = FakeConn(rows)
    calls: list[str] = []

    def verifier(email):
        calls.append(email)
        if email == "tpo@x.edu":
            return verdict(email, "verified", "B")
        return verdict(email, "undeliverable")

    stats = await vf.verify_contact_emails(conn, "colleges", "college-1", verifier=verifier)
    assert stats["checked"] == 2                    # the verified row is not re-checked
    assert stats["verified"] == 1
    assert stats["undeliverable"] == 1
    assert stats["skipped"] == 1
    assert calls == ["tpo@x.edu", "gone@x.edu"]


@pytest.mark.asyncio
async def test_verified_rows_can_be_rechecked_on_request():
    conn = FakeConn([{"id": "3", "email": "old@x.edu", "verification_status": "verified"}])
    stats = await vf.verify_contact_emails(
        conn, "hackathons", "h-1", only_unverified=False,
        verifier=lambda email: verdict(email, "catch_all", "C"),
    )
    assert stats == {"checked": 1, "verified": 0, "catch_all": 1,
                     "undeliverable": 0, "skipped": 0}


@pytest.mark.asyncio
async def test_a_verifier_fault_is_a_skip_not_a_failure_verdict():
    conn = FakeConn([{"id": "1", "email": "tpo@x.edu", "verification_status": "unverified"}])

    def boom(email):
        raise RuntimeError("resolver exploded")

    stats = await vf.verify_contact_emails(conn, "colleges", "college-1", verifier=boom)
    assert stats["skipped"] == 1
    assert stats["checked"] == 0
    assert conn.executed == []                      # nothing written about a mailbox we never checked


@pytest.mark.asyncio
async def test_query_is_scoped_to_one_entity_and_bounded():
    conn = FakeConn([])
    await vf.verify_contact_emails(conn, "colleges", "college-1", limit=5)
    assert "college_id = $1" in conn.sql
    assert "LIMIT $2" in conn.sql


def test_reverify_is_limited_to_the_contact_tables():
    assert set(vf.CONTACT_TABLES) == {"colleges", "hackathons"}
    assert all(table.endswith("_contacts") for table, _ in vf.CONTACT_TABLES.values())
