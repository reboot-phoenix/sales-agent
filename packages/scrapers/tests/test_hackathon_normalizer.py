"""Hackathon normalization: status derivation, mapping, merge safety."""
from scrapers.domains.hackathons.normalizer import (
    _advance_status,
    _merge,
    contact_rows_for,
    derive_mode,
    derive_status,
    normalize_hackathon,
)


def test_derive_status_historical_for_past_event():
    assert derive_status({"event_end": "2020-01-01T00:00:00Z"}) == "HISTORICAL"


def test_derive_status_registration_open_when_deadline_future():
    assert derive_status({"registration_deadline": "2099-01-01T00:00:00Z"}) == "REGISTRATION_OPEN"


def test_derive_status_never_accepts_source_prediction():
    # A source claiming PREDICTED can never make the scraped row itself predicted.
    assert derive_status({"status": "PREDICTED"}) == "ANNOUNCED"
    assert derive_status({"status": "CONFIRMED"}) == "ANNOUNCED"  # no dates => not confirmed


def test_derive_status_confirmed_with_dates():
    assert derive_status({"status": "CONFIRMED", "event_start": "2099-01-01"}) == "CONFIRMED"


def test_derive_mode():
    assert derive_mode({"mode": "online"}) == "online"
    assert derive_mode({"hackathon_type": "virtual"}) == "online"
    assert derive_mode({"city": "Pune"}) == "offline"
    assert derive_mode({}) is None


def test_normalize_hackathon_maps_fields_and_quality():
    normalized = normalize_hackathon({
        "name": "Acme AI Hack",
        "organizer_name": "Acme Labs",
        "hackathon_url": "https://acme.devpost.com/",
        "source_platform": "devpost.com",
        "registration_deadline": "2099-01-31T00:00:00Z",
        "event_start": "2099-02-01T00:00:00Z",
        "city": "Bengaluru",
        "state": "Karnataka",
        "prize_pool": "₹5 Lakh",
        "status": "REGISTRATION_OPEN",
        "themes": ["AI", "ML"],
        "organizer_email": "organizer@acme.com",
    })
    assert normalized["name"] == "Acme AI Hack"
    assert normalized["prize_pool"] == 500_000
    assert normalized["mode"] == "offline"
    assert normalized["status"] == "REGISTRATION_OPEN"
    assert normalized["themes"] == ["AI", "ML"]
    assert normalized["fingerprint"]
    assert normalized["completeness_score"] > 0
    assert normalized["outreach_readiness"] == "PARTIALLY_ENRICHED"


def test_normalize_hackathon_requires_name():
    assert normalize_hackathon({"organizer_name": "No Name"}) is None


def test_normalize_rejects_invalid_email():
    normalized = normalize_hackathon({"name": "X", "organizer_email": "not-an-email"})
    assert normalized["organizer_email"] is None


def test_merge_never_downgrades_protected_url():
    existing = {"hackathon_url": "https://official.example", "state": "Karnataka", "prize_pool": None}
    incoming = {"hackathon_url": "https://scraper.example", "state": "Maharashtra", "prize_pool": 1000}
    merged = _merge(existing, incoming)
    assert merged["hackathon_url"] == "https://official.example"
    assert merged["state"] == "Maharashtra"
    assert merged["prize_pool"] == 1000


def test_advance_status_never_regresses_history():
    assert _advance_status("HISTORICAL", "REGISTRATION_OPEN") == "HISTORICAL"
    assert _advance_status("DISCOVERED", "REGISTRATION_OPEN") == "REGISTRATION_OPEN"
    # A scrape can never move a row into a prediction label.
    assert _advance_status("ANNOUNCED", "PREDICTED") == "ANNOUNCED"


def test_contact_rows_require_locator():
    assert contact_rows_for({"organizer_contact_name": "R Sharma"}) == []
    rows = contact_rows_for({"organizer_contact_name": "R Sharma", "organizer_email": "r@acme.com"})
    assert len(rows) == 1 and rows[0]["priority"] in ("P0", "P1", "P2", "P3", "P4")
