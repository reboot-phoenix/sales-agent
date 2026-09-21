"""Data quality: completeness, freshness windows per domain, readiness, priority."""
from datetime import datetime, timedelta, timezone

from scrapers.domains.quality import (
    best_contact_priority,
    completeness_score,
    confidence_score,
    freshness_category,
    outreach_readiness,
    priority_for_role,
    quality_state,
    verification_score,
)


def test_completeness_reflects_outreach_relevant_fields():
    full = {
        "name": "Acme", "state": "Karnataka", "city": "Bengaluru", "district": "Bengaluru Urban",
        "website_url": "https://acme.edu", "official_email": "office@acme.edu", "phone": "08012345678",
        "university_affiliation": "VTU", "institution_type": "college", "ownership": "private",
        "aishe_code": "C-123", "accreditation": "NAAC", "placement_contact": "placement@acme.edu",
        "tpo_name": "R Sharma", "tpo_email": "tpo@acme.edu", "tpo_phone": "9876543210",
        "principal_name": "Dr A Rao", "director_name": "Dr B Nair", "dean_name": "Dr C Iyer",
    }
    score, missing = completeness_score("colleges", full)
    assert score == 100 and missing == []
    sparse, missing2 = completeness_score("colleges", {"name": "X"})
    assert sparse < 20 and "tpo_email" in missing2


def test_freshness_windows_differ_per_domain():
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    two_days = "2026-05-30T00:00:00Z"
    # A 2-day-old job is recent; a 2-day-old college record is fresh.
    assert freshness_category("jobs", {"last_seen_at": two_days}, now) == "recent"
    assert freshness_category("colleges", {"last_seen_at": two_days}, now) == "fresh"
    # A future event is current.
    assert freshness_category("hackathons", {"event_start": "2026-07-01"}, now) == "fresh"
    # No timestamp is UNKNOWN, never guessed stale.
    assert freshness_category("colleges", {}, now) == "unknown"


def test_verification_and_confidence():
    assert verification_score({"verification_status": "verified", "source_count": 3}) == 100
    assert verification_score({"verification_status": "unverified"}) <= 20
    low = confidence_score("colleges", {"name": "X", "verification_status": "unverified", "source_count": 1})
    high = confidence_score("colleges", {
        "name": "X", "state": "KA", "city": "BLR", "district": "BLR", "website_url": "https://x.edu",
        "official_email": "a@x.edu", "phone": "1", "tpo_email": "tpo@x.edu", "tpo_name": "A",
        "verification_status": "verified", "source_count": 3,
    }, contact_verified=True)
    assert high > low


def test_outreach_readiness_never_ready_without_contact():
    assert outreach_readiness("colleges", {"name": "X"}, has_contact_locator=False) == "INSUFFICIENT_DATA"
    # Filled institution but still no locator -> needs enrichment.
    filled = {"name": "X", "state": "KA", "city": "BLR", "district": "BLR", "website_url": "https://x.edu",
              "official_email": "a@x.edu", "phone": "1", "university_affiliation": "U",
              "institution_type": "college", "ownership": "private", "aishe_code": "1",
              "accreditation": "NAAC", "placement_contact": "p@x.edu"}
    assert outreach_readiness("colleges", filled, has_contact_locator=False) == "NEEDS_ENRICHMENT"
    assert outreach_readiness("colleges", filled, has_contact_locator=True, contact_locator_count=1) == "PARTIALLY_ENRICHED"
    verified = {**filled, "verification_status": "verified", "tpo_email": "tpo@x.edu"}
    assert outreach_readiness("colleges", verified, has_contact_locator=True, contact_locator_count=1) == "OUTREACH_READY"


def test_contact_priority_mapping():
    assert priority_for_role("colleges", "tpo") == "P0"
    assert priority_for_role("colleges", "placement_head") == "P0"
    assert priority_for_role("colleges", "principal") == "P1"
    assert priority_for_role("colleges", "dean") == "P2"
    assert priority_for_role("hackathons", "outreach") == "P0"
    assert priority_for_role("hackathons", "sponsor") == "P2"
    assert best_contact_priority(["P3", "P1", "P4"]) == "P1"
    assert best_contact_priority([]) is None


def test_quality_state_transitions():
    assert quality_state("colleges", {"verification_status": "verified"}) == "VERIFIED"
    assert quality_state("colleges", {"enrichment_status": "FAILED"}) == "FAILED"
    assert quality_state("colleges", {"name": "X"}) == "NEEDS_REVIEW"
    assert quality_state("colleges", {"name": "X", "state": "KA"}, has_contact_locator=True) == "ENRICHED"
