"""Hackathon adapter parsers (offline). Live HTTP is EXTERNAL_DEPENDENCY."""
import json

from scrapers.domains.hackathons.adapters import (
    DevfolioAdapter,
    DevpostAdapter,
    HackerEarthChallengesAdapter,
    MlhAdapter,
    UnstopHackathonAdapter,
    extract_json_ld,
    find_key_list,
)


def test_extract_json_ld_tolerates_bad_block():
    html = (
        '<script type="application/ld+json">{"@type":"Event","name":"A"}</script>'
        '<script type="application/ld+json">{bad json}</script>'
    )
    blocks = extract_json_ld(html)
    assert len(blocks) == 1 and blocks[0]["name"] == "A"


def test_find_key_list_searches_nested_envelopes():
    assert find_key_list({"data": {"data": [{"x": 1}]}}, ("data",)) == [{"x": 1}]
    assert find_key_list({"hackathons": [{"x": 1}]}, ("hackathons",)) == [{"x": 1}]
    assert find_key_list({"other": 1}, ("hackathons",)) == []


def test_devpost_parse_item():
    parsed = DevpostAdapter.parse_item({
        "id": 1,
        "title": "Acme AI Hack",
        "url": "https://acme.devpost.com/",
        "open_state": "open",
        "submission_period_dates": "Jan 01 - Jan 31, 2026",
        "displayed_location": {"location": "Bengaluru, Karnataka"},
        "organization_name": "Acme Labs",
        "themes": [{"name": "Machine Learning/AI"}],
        "prizes": [{"amount": "$10,000"}, {"amount": "$2,000"}],
    })
    assert parsed["name"] == "Acme AI Hack"
    assert parsed["organizer_name"] == "Acme Labs"
    assert parsed["status"] == "REGISTRATION_OPEN"
    assert parsed["mode"] == "offline"
    assert parsed["city"] == "Bengaluru"
    assert parsed["prize_pool"] == 10_000
    assert parsed["technology"] == "Machine Learning/AI"


def test_devpost_requires_title():
    assert DevpostAdapter.parse_item({"company": "NoTitle"}) is None


def test_unstop_parse_item():
    parsed = UnstopHackathonAdapter.parse_item({
        "title": "Code For Bharat",
        "seo_url": "https://unstop.com/hackathons/code-for-bharat",
        "organisation": {"name": "Unstop", "website": "https://unstop.com"},
        "locations": [{"city": "Mumbai", "state": "Maharashtra"}],
        "is_online": False,
        "hackathonDetail": {"prize": "₹2,50,000", "end_date": "2026-08-01T00:00:00Z"},
    })
    assert parsed["name"] == "Code For Bharat"
    assert parsed["prize_pool"] == 250_000
    assert parsed["city"] == "Mumbai"
    # Registration deadline is only asserted when the source states one.
    assert parsed["registration_deadline"] is not None


def test_mlh_json_ld_event():
    event = {
        "@type": "Event",
        "name": "MLH Global Hack Week",
        "url": "https://mlh.io/events/global-hack-week",
        "startDate": "2026-04-01T09:00:00Z",
        "endDate": "2026-04-07T18:00:00Z",
        "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
        "organizer": {"name": "Major League Hacking", "url": "https://mlh.io"},
        "location": {"address": {"addressLocality": "Remote", "addressCountry": "US"}},
    }
    html = f'<script type="application/ld+json">{json.dumps(event)}</script>'
    parsed = MlhAdapter.parse_html(html)
    assert len(parsed) == 1
    assert parsed[0]["mode"] == "online"
    assert parsed[0]["student_only"] is True
    assert parsed[0]["year"] == 2026


def test_devfolio_next_data():
    payload = {"props": {"pageProps": {"hackathons": [{
        "name": "ETH India",
        "slug": "eth-india",
        "starts_at": "2026-12-01T00:00:00Z",
        "ends_at": "2026-12-03T00:00:00Z",
    }]}}}
    html = f'<script id="__NEXT_DATA__">{json.dumps(payload)}</script>'
    parsed = DevfolioAdapter.parse_html(html)
    assert parsed and parsed[0]["hackathon_url"] == "https://devfolio.co/hackathons/eth-india"


def test_hackerearth_json_ld():
    event = {"@type": "Event", "name": "HE Challenge", "url": "https://hackerearth.com/challenges/x",
             "startDate": "2026-05-01", "endDate": "2026-05-02"}
    html = f'<script type="application/ld+json">{json.dumps(event)}</script>'
    parsed = HackerEarthChallengesAdapter.parse_html(html)
    assert parsed and parsed[0]["source_platform"] == "hackerearth.com"


def test_adapters_never_fabricate_contact_details():
    parsed = DevpostAdapter.parse_item({"title": "No Contacts Hack"})
    # Enrichment discovers contacts later; the adapter must not invent any.
    assert "contact_email" not in parsed or parsed.get("contact_email") in (None, "")
    assert parsed.get("organizer_email") in (None, "")
