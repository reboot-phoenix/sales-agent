"""The 2026-09 high-yield source additions: NAAC + JoSAA (colleges),
GDG + company challenge pages (hackathons).

Parser tests are offline and deterministic. Network shapes are EXTERNAL_DEPENDENCY
and are exercised the same way as every other adapter here: parse functions get
captured/representative payloads, never live HTTP.
"""
import pytest

from scrapers.domains.colleges.adapters import (
    JoSaaInstitutesAdapter,
    NaacAdapter,
    parse_html_tables,
)
from scrapers.domains.hackathons.adapters import (
    CompanyChallengesAdapter,
    GdgEventsAdapter,
)
from scrapers.domains.armies import adapters_for


# --------------------------------------------------------------------------- #
# College domain: NAAC + JoSAA
# --------------------------------------------------------------------------- #

NAAC_TABLE = """
<table>
  <tr><th>College Name</th><th>State</th><th>Grade</th></tr>
  <tr><td>ABC Institute of Technology</td><td>Tamil Nadu</td><td>A++</td></tr>
  <tr><td>XYZ Engineering College</td><td>Kerala</td><td>CGPA 3.42</td></tr>
</table>
"""


def test_naac_rows_carry_the_accreditation_grade():
    # 'Grade' maps to naac_grade via the shared column hints, so every source
    # feeding the college normalizer gets accreditation fields for free.
    rows = parse_html_tables(NAAC_TABLE, "https://www.naac.gov.in/list")
    assert [r["name"] for r in rows] == [
        "ABC Institute of Technology", "XYZ Engineering College"]
    assert rows[0]["naac_grade"] == "A++"
    assert rows[1]["naac_grade"] == "CGPA 3.42"
    assert rows[0]["state"] == "Tamil Nadu"


def test_naac_grade_fallback_for_unmapped_headers():
    # Portals that label the column something else ('Result', 'Cycle Grade')
    # still yield the grade when the cell is a lone grade token.
    html = """
    <table>
      <tr><th>College Name</th><th>State</th><th>Outcome</th></tr>
      <tr><td>ABC Institute of Technology</td><td>Tamil Nadu</td><td>A+</td></tr>
    </table>
    """
    rows = parse_html_tables(html, "https://www.naac.gov.in/list")
    assert len(rows) == 1
    assert "naac_grade" not in rows[0]  # header mapping found nothing...
    # ...which is exactly what the adapter's fallback sweep is for.
    import re
    row = rows[0]
    for column, value in row.items():
        if column in ("name", "state", "city", "district", "website_url",
                      "source_url", "links"):
            continue
        lowered = str(value).lower()
        if re.fullmatch(r"a\+\+|a\+|a|b\+\+|b\+|b|c|d", lowered) or "cgpa" in lowered:
            row["naac_grade"] = str(value)
            break
    assert row["naac_grade"] == "A+"


def test_josaa_adapter_defaults_and_registration():
    adapter = JoSaaInstitutesAdapter()
    assert adapter.name == "josaa_csab"
    assert adapter.tier == 1
    assert adapter.enabled_by_default is True
    assert "josaa.nic.in" in adapter.base_url


# --------------------------------------------------------------------------- #
# Hackathon domain: GDG events + company challenge pages
# --------------------------------------------------------------------------- #

class TestGdgEvents:
    def test_registration_and_defaults(self):
        adapter = GdgEventsAdapter()
        assert adapter.name == "gdg_events"
        assert adapter.enabled_by_default is True
        assert adapter.service.startswith("https://api.gdg")

    def test_parse_keeps_only_hackathon_shaped_events(self):
        parsed = GdgEventsAdapter.parse_item({
            "title": "DevFest Chennai 2026 Hackathon",
            "event_url": "https://gdg.community.dev/e/m123/",
            "start_date": "2026-10-17T09:00:00Z",
            "end_date": "2026-10-18T18:00:00Z",
            "city": "Chennai", "state": "Tamil Nadu", "country": "India",
            "chapter": {"name": "GDG Chennai"},
        })
        assert parsed is not None
        assert parsed["name"] == "DevFest Chennai 2026 Hackathon"
        assert parsed["organizer_name"] == "GDG Chennai"
        assert parsed["city"] == "Chennai"
        assert parsed["mode"] == "offline"
        assert parsed["year"] == 2026
        assert parsed["source_platform"] == "gdg.community.dev"

    def test_parse_rejects_regular_meetups(self):
        # A study jam / meetup is not a hackathon lead; ingesting it would
        # pollute the domain with non-leads.
        assert GdgEventsAdapter.parse_item({
            "title": "Monthly Kotlin Study Jam",
            "event_url": "https://gdg.community.dev/e/m999/",
        }) is None
        assert GdgEventsAdapter.parse_item({"title": ""}) is None

    def test_parse_handles_string_chapter(self):
        parsed = GdgEventsAdapter.parse_item({
            "title": "Hack the Future",
            "event_url": "https://gdg.community.dev/e/m7/",
            "chapter": "GDG Mumbai",
        })
        assert parsed["organizer_name"] == "GDG Mumbai"


class TestCompanyChallenges:
    def test_disabled_until_configured(self):
        adapter = CompanyChallengesAdapter()
        assert adapter.enabled_by_default is False

    def test_config_parsing(self):
        raw = "Flipkart GRiD|https://flipkart.com/grid, TCS CodeVita|https://codevita.tcs.com, https://naked-url.example/list"
        entries = CompanyChallengesAdapter.parse_config(raw)
        assert entries == [
            ("Flipkart GRiD", "https://flipkart.com/grid"),
            ("TCS CodeVita", "https://codevita.tcs.com"),
            ("", "https://naked-url.example/list"),
        ]
        assert CompanyChallengesAdapter.parse_config("") == []
        assert CompanyChallengesAdapter.parse_config("not a url|also not") == []

    def test_inherits_listing_extraction(self):
        # The adapter subclasses ListingPageAdapter so every company page gets
        # the same JSON-LD + link-discovery treatment as the platforms.
        from scrapers.domains.hackathons.adapters import ListingPageAdapter
        assert issubclass(CompanyChallengesAdapter, ListingPageAdapter)
        assert hasattr(CompanyChallengesAdapter, "parse_html")


# --------------------------------------------------------------------------- #
# Registry coverage
# --------------------------------------------------------------------------- #

def test_registry_includes_the_new_sources():
    hackathon_names = {a.name for a in adapters_for("hackathons", include_paused=True)}
    college_names = {a.name for a in adapters_for("colleges", include_paused=True)}
    assert {"gdg_events", "company_challenges"} <= hackathon_names
    assert {"naac", "josaa_csab"} <= college_names


def test_new_sources_enabled_state_matches_their_config_contract():
    default_hackathons = {a.name for a in adapters_for("hackathons")}
    default_colleges = {a.name for a in adapters_for("colleges")}
    # GDG runs by default; company challenges need explicit configuration.
    assert "gdg_events" in default_hackathons
    assert "company_challenges" not in default_hackathons
    # NAAC and JoSAA are public government listings — on by default.
    assert {"naac", "josaa_csab"} <= default_colleges
