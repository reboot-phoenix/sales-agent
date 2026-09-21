"""EDA over real collected rows — counts only, no manufactured statistics."""
from scrapers.domains.colleges.eda import summarize_colleges
from scrapers.domains.hackathons.eda import summarize_hackathons


def test_hackathon_eda_counts_and_buckets():
    rows = [
        {
            "name": "A Hack", "organizer_name": "Acme", "state": "Karnataka", "city": "Bengaluru",
            "event_start": "2026-03-05", "mode": "offline", "technology": "AI",
            "domain": "ai", "prize_pool": 600_000, "student_only": True,
            "hiring_opportunities": True, "source_platform": "devpost.com",
            "status": "REGISTRATION_OPEN", "occurrence_type": "recurring",
        },
        {
            "name": "B Hack", "organizer_name": "Acme", "state": "Maharashtra", "city": "Pune",
            "event_start": "2026-03-20", "mode": "online", "technology": "AI",
            "prize_pool": 30_000, "open_to_public": True, "source_platform": "unstop.com",
            "status": "ANNOUNCED",
        },
    ]
    result = summarize_hackathons(rows)
    assert result["total"] == 2
    assert result["recurring_organizers"] == 1  # Acme ran 2
    assert result["by_month"]["3"] == 2
    assert result["by_state"][0]["value"] in ("Karnataka", "Maharashtra")
    assert result["prize_buckets"]["above_5L"] == 1
    assert result["prize_buckets"]["under_50k"] == 1
    assert result["average_prize_pool"] == 315_000  # (600k + 30k) / 2, no fabricated rows
    # A 5L prize is not 'above 5L' — bucket edges are respected exactly.
    assert summarize_hackathons([{**rows[0], "prize_pool": 500_000}])["prize_buckets"]["above_5L"] == 0
    assert result["hiring_linked"] == 1
    assert result["student_only"] == 1
    assert result["recurring_hackathons"] == 1


def test_hackathon_eda_empty_dataset_is_zeros_not_fabricated():
    result = summarize_hackathons([])
    assert result["total"] == 0
    assert result["average_prize_pool"] is None
    assert result["recurring_organizers"] == 0
    assert result["by_state"] == []


def test_college_eda_coverage_counts():
    rows = [
        {
            "name": "A College", "state": "Kerala", "district": "Ernakulam", "city": "Kochi",
            "institution_type": "college", "ownership": "private", "website_url": "https://a.edu",
            "official_email": "a@a.edu", "tpo_name": "R Sharma", "principal_name": "Dr X",
            "nirf_rank": 50, "source_urls": ["https://aishe.gov.in/dump"],
            "contact_coverage": {"contacts": 3, "emails": 2, "by_role": {"tpo": 1}},
            "completeness_score": 80, "enrichment_status": "ENRICHED",
            "outreach_readiness": "OUTREACH_READY",
        },
        {
            "name": "B College", "state": "Kerala", "district": "Kollam", "city": "Kollam",
            "institution_type": "university", "ownership": "government",
            "completeness_score": 40, "enrichment_status": "NORMALIZED",
            "outreach_readiness": "NEEDS_ENRICHMENT",
        },
    ]
    result = summarize_colleges(rows)
    assert result["total"] == 2
    assert result["states_covered"] == 1
    assert result["districts_covered"] == 2
    assert result["with_website"] == 1
    assert result["tpo_coverage"] == 1
    assert result["nirf_ranked"] == 1
    assert result["contacts_total"] == 3
    assert result["average_completeness"] == 60.0
    assert result["by_ownership"]["private"] == 1
    assert result["measured"] is True
