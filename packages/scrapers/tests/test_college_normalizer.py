"""College normalization: mapping, derivation, merge safety."""
from scrapers.domains.colleges.normalizer import (
    _merge,
    derive_institution_type,
    derive_ownership,
    normalize_college,
)


def test_derive_ownership():
    assert derive_ownership({"ownership": "Government"}) == "government"
    assert derive_ownership({"institution_type": "Private Unaided"}) == "private"
    assert derive_ownership({"name": "Autonomous College"}) == "autonomous"
    assert derive_ownership({"name": "Foo"}) is None


def test_derive_institution_type():
    assert derive_institution_type({"name": "ABC University"}) == "university"
    assert derive_institution_type({"name": "ABC Institute of Technology"}) == "institute"
    assert derive_institution_type({"name": "ABC College"}) == "college"


def test_normalize_college_maps_and_normalizes_url():
    normalized = normalize_college({
        "name": "ABC Institute of Technology",
        "state": "Tamil Nadu",
        "district": "Chennai",
        "city": "Chennai",
        "website_url": "abc.edu",
        "official_email": "office@abc.edu",
        "aishe_code": "C-12345",
        "ownership": "Private",
    })
    assert normalized["website_url"] == "https://abc.edu"
    assert normalized["ownership"] == "private"
    assert normalized["is_public"] is False
    assert normalized["fingerprint"]
    assert normalized["completeness_score"] > 0
    assert normalized["outreach_readiness"] == "NEEDS_ENRICHMENT"


def test_normalize_college_requires_name():
    assert normalize_college({"state": "Kerala"}) is None


def test_merge_preserves_existing_official_website():
    existing = {"website_url": "https://official.edu", "city": "Chennai"}
    incoming = {"website_url": "https://spam.example", "city": "Madurai", "aishe_code": "C-1"}
    merged = _merge(existing, incoming)
    assert merged["website_url"] == "https://official.edu"
    assert merged["city"] == "Madurai"
    assert merged["aishe_code"] == "C-1"
