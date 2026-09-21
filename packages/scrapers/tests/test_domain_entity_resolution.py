"""Entity resolution: fingerprints, fuzzy matching, contact identity."""
from scrapers.domains.entity_resolution import (
    contact_identity,
    fingerprint_college,
    fingerprint_hackathon,
    name_similarity,
    same_college,
    same_hackathon,
    slug_for,
)


def test_hackathon_fingerprint_is_deterministic_and_specific():
    a = fingerprint_hackathon("Smart India Hackathon", "AICTE", "https://sih.gov.in")
    b = fingerprint_hackathon("smart  india hackathon", "AICTE", "https://sih.gov.in/")
    assert a == b  # normalization makes spelling/whitespace irrelevant
    c = fingerprint_hackathon("Smart India Hackathon", "Other Org", "https://sih.gov.in")
    assert c != a


def test_college_fingerprint_prefers_aishe():
    with_code = fingerprint_college("Some College", "Karnataka", "C-12345", "https://x.edu")
    same_code_other_name = fingerprint_college("Some College Renamed", "Karnataka", "C-12345", "https://y.edu")
    assert with_code == same_code_other_name
    without_code_named = fingerprint_college("Some College", "Karnataka", None, "https://x.edu")
    assert without_code_named != with_code


def test_same_hackathon_url_is_decisive():
    a = {"name": "Foo Hack", "hackathon_url": "https://devpost.com/x", "year": 2026}
    b = {"name": "Foo Hack (2026)", "hackathon_url": "https://devpost.com/x", "year": 2026}
    is_same, conf, signals = same_hackathon(a, b)
    assert is_same and conf == 1.0 and "hackathon_url" in signals


def test_same_hackathon_name_and_year():
    a = {"name": "Foo Hack", "year": 2026}
    b = {"name": "FOO HACK", "year": 2026}
    is_same, _conf, signals = same_hackathon(a, b)
    assert is_same and "name" in signals and "year" in signals


def test_same_college_by_domain_and_state():
    a = {"name": "ABC Institute", "state": "Tamil Nadu", "website_url": "https://abc.edu"}
    b = {"name": "ABC Institute of Technology", "state": "Tamil Nadu", "website_url": "https://abc.edu/home"}
    is_same, _conf, signals = same_college(a, b)
    assert is_same and "website_domain" in signals


def test_same_college_requires_state_for_name_match():
    # Same generic name in different states must NOT merge.
    a = {"name": "Government Engineering College", "state": "Kerala"}
    b = {"name": "Government Engineering College", "state": "Gujarat"}
    is_same, _conf, _signals = same_college(a, b)
    assert is_same is False


def test_name_similarity_and_slug():
    assert name_similarity("Indian Institute of Technology", "Indian Institute of Technology") == 1.0
    assert name_similarity("IIT Bombay", "NIT Trichy") < 0.6
    assert slug_for("Foo Bar", "2026") == "foo-bar-2026"


def test_contact_identity_requires_a_locator():
    assert contact_identity("R Sharma") is None
    assert contact_identity("R Sharma", email="TPO@College.edu") == contact_identity(
        "Different Name", email="tpo@college.edu"
    )
    assert contact_identity(None, phone="+91 98765 43210") == contact_identity(None, phone="9876543210")
    assert contact_identity(None, linkedin="https://linkedin.com/in/r-sharma/") is not None
