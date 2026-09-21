"""College contact enrichment: role extraction, provenance, no fabrication."""
from scrapers.domains.colleges.enrichment import (
    candidate_contact_urls,
    _valid_email,
    _clean_phone,
    extract_role_contacts,
)

TPO_HTML = """
<html><body>
  <div><p>Dr. A B Sharma, Training &amp; Placement Officer</p>
       <a href="mailto:tpo@college.edu">tpo@college.edu</a></div>
  <div><p>Placement Head</p><a href="tel:+919876543210">+91 98765 43210</a></div>
  <div><p>Principal</p><a href="mailto:principal@college.edu">principal@college.edu</a></div>
</body></html>
"""


def test_extracts_tpo_contact_with_role_and_priority():
    contacts = extract_role_contacts(TPO_HTML, "https://college.edu/placement")
    tpo = next((c for c in contacts if c["role_category"] == "tpo"), None)
    assert tpo is not None
    assert tpo["email"] == "tpo@college.edu"
    assert tpo["priority"] == "P0"
    assert tpo["full_name"] and "Sharma" in tpo["full_name"]
    assert tpo["source_url"] == "https://college.edu/placement"
    assert tpo["contact_source"] == "official_website"


def test_extracts_principal_and_phone_contact():
    contacts = extract_role_contacts(TPO_HTML, "https://college.edu/contact")
    roles = {c["role_category"] for c in contacts}
    assert "principal" in roles
    assert "placement_head" in roles
    phone_contact = next((c for c in contacts if c["phone"]), None)
    assert phone_contact is not None and phone_contact["phone"].startswith("+91")


def test_generic_inbox_is_official_not_a_person():
    html = '<div><p>For enquiries contact the office</p><a href="mailto:info@college.edu">info@college.edu</a></div>'
    contacts = extract_role_contacts(html, "https://college.edu")
    assert len(contacts) == 1
    assert contacts[0]["role_category"] == "official"
    assert contacts[0]["full_name"] is None


def test_no_locator_means_no_contact():
    html = "<div><p>Welcome to ABC College, Principal's message</p></div>"
    assert extract_role_contacts(html, "https://college.edu") == []


def test_rejects_placeholder_and_unrelated_links():
    html = '<div><a href="https://linkedin.com/company/abc">Follow us on LinkedIn</a></div>'
    assert extract_role_contacts(html, "https://college.edu") == []
    assert _valid_email("noreply@college.edu") is False
    assert _valid_email("a@example.com") is False
    assert _valid_email("tpo@college.edu") is True


def test_phone_validation_requires_real_length():
    assert _clean_phone("+91 98765 43210") is not None
    assert _clean_phone("12345") is None


def test_candidate_urls_are_bounded_and_public():
    urls = candidate_contact_urls("https://www.college.edu")
    assert urls and all(u.startswith("https://college.edu") for u in urls)
    assert any(u.endswith("/placement") for u in urls)
    assert candidate_contact_urls(None) == []
