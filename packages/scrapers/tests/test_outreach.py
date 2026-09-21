"""Unified outreach readiness: ready means reachable, and verified.

These tests pin the rules the business depends on: a URL is never readiness, an
unverified locator is only partial, and predicted hackathons never outrank live
ones. Every assessment is pure computation, so no DB or network is involved.
"""
from datetime import date, timedelta

import pytest

from scrapers.domains import outreach as ot

TODAY = date(2026, 9, 21)


def contact(**kwargs):
    base = {
        "full_name": "Asha Rao", "role_category": "tpo", "priority": "P0",
        "email": None, "phone": None, "linkedin_url": None,
        "verification_status": "unverified", "verification_grade": None,
    }
    base.update(kwargs)
    return base


def test_verified_person_email_plus_role_reaches_p0():
    assessment = ot.assess_lead(
        "colleges",
        {"id": "c1", "name": "ABC College", "city": "Pune", "state": "MH",
         "website_url": "https://abc.edu", "completeness_score": 70},
        [contact(email="asha.rao@abc.edu", verification_status="verified",
                 verification_grade="A")],
        today=TODAY,
    )
    assert assessment.readiness == "OUTREACH_READY"
    assert assessment.priority == "P0"
    assert assessment.score >= 75
    assert any("verified personal email" in r for r in assessment.reasons)


def test_role_mailbox_is_ready_but_ranks_below_a_named_person():
    def score(email):
        return ot.assess_lead(
            "colleges",
            {"id": "c1", "name": "ABC", "city": "Pune", "state": "MH",
             "website_url": "https://abc.edu", "completeness_score": 70},
            [contact(email=email, verification_status="verified", verification_grade="A")],
            today=TODAY,
        ).score

    assert score("placement@abc.edu") < score("asha.rao@abc.edu")


def test_a_url_alone_is_never_outreach_ready():
    assessment = ot.assess_lead(
        "colleges",
        {"id": "c2", "name": "Thin College", "website_url": "https://thin.edu",
         "city": "Kota", "state": "RJ", "completeness_score": 40},
        [],
        today=TODAY,
    )
    assert assessment.readiness == "NEEDS_ENRICHMENT"
    assert assessment.priority in ("P3", "P4")
    assert "no reachable contact" in " ".join(assessment.blockers)


def test_unverified_locator_is_partial_and_says_so():
    assessment = ot.assess_lead(
        "colleges",
        {"id": "c3", "name": "ABC", "city": "Pune", "state": "MH",
         "website_url": "https://abc.edu", "completeness_score": 65},
        [contact(email="tpo@abc.edu", verification_status="unverified")],
        today=TODAY,
    )
    assert assessment.readiness == "PARTIALLY_ENRICHED"
    assert "not verified" in " ".join(assessment.blockers)
    assert any("unverified email" in r for r in assessment.reasons)


def test_undeliverable_locator_does_not_count_towards_readiness():
    record = {"id": "c4", "name": "ABC", "city": "Pune", "completeness_score": 60}
    dead = ot.assess_lead(
        "colleges", record,
        [contact(email="gone@abc.edu", verification_status="failed")],
        today=TODAY,
    )
    alive = ot.assess_lead(
        "colleges", record,
        [contact(email="tpo@abc.edu", verification_status="verified",
                 verification_grade="B")],
        today=TODAY,
    )
    # A failed address scores zero locator weight, so it cannot carry readiness
    # and it must never score as high as a working mailbox on the same lead.
    assert dead.readiness == "NEEDS_ENRICHMENT"
    assert "failed verification" in " ".join(dead.reasons)
    assert dead.score < alive.score


def test_jobs_freshness_decays_by_day():
    def score(posted_days_ago):
        return ot.assess_lead(
            "jobs",
            {"id": "j1", "title": "Fresher SDE", "company_name": "Acme",
             "city": "Bengaluru", "posted_at": TODAY - timedelta(days=posted_days_ago),
             "completeness_score": 60},
            [contact(role_category="hr", email="hr@acme.com",
                     verification_status="verified", verification_grade="A")],
            today=TODAY,
        ).score

    assert score(1) > score(10) > score(30) > score(200)


def test_hackathon_registration_deadline_beats_a_predicted_recurrence():
    live = ot.assess_lead(
        "hackathons",
        {"id": "h1", "name": "Smart India Hackathon", "city": "Delhi",
         "registration_deadline": TODAY + timedelta(days=10),
         "occurrence_type": "CONFIRMED", "completeness_score": 60},
        [contact(role_category="organizer", email="organizer@sih.gov.in",
                 verification_status="verified", verification_grade="A")],
        today=TODAY,
    )
    predicted = ot.assess_lead(
        "hackathons",
        {"id": "h2", "name": "Recurring Hack", "city": "Delhi",
         "occurrence_type": "PREDICTED", "completeness_score": 60},
        [contact(role_category="organizer", email="organizer@recurring.in",
                 verification_status="verified", verification_grade="A")],
        today=TODAY,
    )
    assert live.score > predicted.score
    assert any("registration closes" in r for r in live.reasons)
    assert any("predicted recurrence" in r for r in predicted.reasons)


def test_college_readiness_uses_the_placement_season_hook():
    in_season = ot.assess_lead(
        "colleges",
        {"id": "c5", "name": "ABC", "city": "Pune", "completeness_score": 60},
        [contact(email="tpo@abc.edu", verification_status="verified", verification_grade="B")],
        today=date(2026, 10, 1),
    )
    off_season = ot.assess_lead(
        "colleges",
        {"id": "c5", "name": "ABC", "city": "Pune", "completeness_score": 60},
        [contact(email="tpo@abc.edu", verification_status="verified", verification_grade="B")],
        today=date(2026, 2, 1),
    )
    assert in_season.score > off_season.score
    assert any("placement season" in r for r in in_season.reasons)


def test_priority_never_upgrades_a_lead_that_is_not_reachable():
    assessment = ot.assess_lead(
        "jobs",
        {"id": "j9", "title": "Fresher", "company_name": "Acme",
         "posted_at": TODAY, "completeness_score": 100},
        [],
        today=TODAY,
    )
    assert assessment.readiness == "NEEDS_ENRICHMENT"
    assert assessment.priority in ("P3", "P4")


def test_best_contact_prefers_the_most_reachable_person():
    contacts = [
        contact(full_name="Dean", role_category="dean", email="dean@x.edu",
                verification_status="unverified"),
        contact(full_name="Placement Head", role_category="placement_head",
                email="ph@x.edu", verification_status="verified", verification_grade="A"),
        contact(full_name="TPO", role_category="tpo", linkedin_url="https://linkedin.com/in/tpo",
                verification_status="unverified"),
    ]
    best = ot.best_contact(contacts)
    assert best["full_name"] == "Placement Head"


def test_unknown_domain_is_rejected_loudly():
    with pytest.raises(ValueError):
        ot.assess_lead("universities", {"id": "x"}, [])


def test_rank_sorts_by_score_then_readiness():
    low = ot.OutreachAssessment(domain="jobs", entity_id="a", name="A", score=30,
                                readiness="PARTIALLY_ENRICHED", priority="P3")
    high = ot.OutreachAssessment(domain="jobs", entity_id="b", name="B", score=80,
                                 readiness="OUTREACH_READY", priority="P0")
    assert [a.entity_id for a in ot.rank([low, high])] == ["b", "a"]


def test_assessment_serialises_for_the_api():
    payload = ot.OutreachAssessment(domain="colleges", entity_id="c1", name="ABC").to_dict()
    assert set(payload) == {
        "domain", "entity_id", "name", "score", "priority", "readiness",
        "best_contact", "reasons", "blockers",
    }


class _FakeConn:
    """Records the batch contact query instead of hitting Postgres."""

    def __init__(self, rows):
        self.rows = rows
        self.queries: list[str] = []

    async def fetch(self, sql, *args):
        self.queries.append(sql)
        return self.rows


@pytest.mark.asyncio
async def test_assess_domain_loads_contacts_in_one_query():
    conn = _FakeConn([
        {"college_id": "c1", "email": "tpo@abc.edu", "role_category": "tpo",
         "verification_status": "verified", "verification_grade": "B"},
        {"college_id": "c2", "email": "x@y.edu", "role_category": "principal",
         "verification_status": "unverified", "verification_grade": None},
    ])
    records = [
        {"id": "c1", "name": "ABC", "city": "Pune", "completeness_score": 60},
        {"id": "c2", "name": "XYZ", "city": "Indore", "completeness_score": 60},
    ]
    results = await ot.assess_domain(conn, "colleges", records, today=TODAY)
    assert len(conn.queries) == 1                      # no N+1
    by_id = {r.entity_id: r for r in results}
    assert by_id["c1"].readiness == "OUTREACH_READY"
    assert by_id["c2"].readiness == "PARTIALLY_ENRICHED"
