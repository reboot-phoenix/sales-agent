"""The expanded source list: listing pages, feeds, datasets, and paused sources.

Everything here is offline. The point is that a source only ever reports what the
page itself published, cross-site links are ignored, and sources that need a
terms review stay disabled unless an operator names them explicitly.
"""
import pytest

from scrapers.domains.armies import adapters_for
from scrapers.domains.colleges.adapters import (
    AicteInstitutionsAdapter,
    Careers360Adapter,
    CollegeDatasetAdapter,
    StateTpoAdapter,
    _parse_generic_json_colleges,
)
from scrapers.domains.hackathons.adapters import (
    CodeChefContestsAdapter,
    CuratedListAdapter,
    DoraHacksAdapter,
    HackIndiaAdapter,
    ReskilllAdapter,
    RssHackathonAdapter,
    SihPortalAdapter,
    name_from_url,
)

EVENT_JSON_LD = """
<script type="application/ld+json">
{"@type": "Event", "name": "Acme Hack 2027", "startDate": "2027-03-05T09:00:00+05:30",
 "endDate": "2027-03-07T18:00:00+05:30", "url": "https://dorahacks.io/hackathon/acme-hack-2027",
 "description": "<b>Build</b> something",
 "location": {"name": "BIT Bengaluru", "address": {"addressLocality": "Bengaluru",
   "addressRegion": "Karnataka", "addressCountry": "IN"}},
 "organizer": {"@type": "Organization", "name": "Acme Labs", "url": "https://acme.example"},
 "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode"}
</script>
"""


def test_listing_adapter_prefers_structured_data():
    rows = DoraHacksAdapter.parse_html(EVENT_JSON_LD, "https://dorahacks.io/hackathon")
    assert len(rows) == 1
    row = rows[0]
    assert row["_extraction"] == "json_ld"
    assert row["name"] == "Acme Hack 2027"
    assert row["mode"] == "offline"
    assert row["city"] == "Bengaluru" and row["state"] == "Karnataka"
    assert row["organizer_name"] == "Acme Labs"
    assert row["event_start"].startswith("2027-03-05")
    assert row["organization_description"] == "Build something"
    assert row["source_url"] == row["hackathon_url"]


def test_link_discovery_is_same_site_only_and_labelled():
    html = """
      <a href="/hackathon/quantum-hack-2027">Quantum Hack 2027</a>
      <a href="/blog/recap">Recap</a>
      <a href="https://other-board.com/hackathon/some-other-hack">Other board</a>
      <a href="/hackathon/details">Details</a>
    """
    rows = DoraHacksAdapter.parse_html(html, "https://dorahacks.io/hackathon")
    names = [r["name"] for r in rows]
    assert "Quantum Hack 2027" in names
    assert not any("Other board" in n for n in names)
    link_rows = [r for r in rows if r["_extraction"] == "link_discovery"]
    assert link_rows and all(r["status"] == "DISCOVERED" for r in link_rows)
    # "Details" is a bare link word, so no record is invented from it.
    assert not any(r["name"].lower() == "details" for r in rows)


def test_every_listing_adapter_declares_a_platform_and_public_base_url():
    for adapter in (DoraHacksAdapter, HackIndiaAdapter, ReskilllAdapter, SihPortalAdapter):
        assert adapter.platform and "." in adapter.platform
        assert adapter.base_url and adapter.base_url.startswith("https://")
        assert adapter.listing_urls, f"{adapter.name} has no listing url"
        assert adapter.verification_note, f"{adapter.name} must state what is verified"


def test_name_from_url_derives_from_the_sources_own_slug_only_when_it_can():
    assert name_from_url("https://x.io/hackathon/smart-india-hackathon-2026") == "Smart India Hackathon 2026"
    assert name_from_url("https://x.io/hackathon/mlh") is None      # one word is not a name
    assert name_from_url("https://x.io/hackathon/view") is None      # a UI word is not a name
    assert name_from_url("https://x.io/") is None


def test_rss_adapter_reads_only_what_the_feed_publishes():
    feed = (
        "<rss><channel><item><title>MLH Local Hack Day</title>"
        "<link>https://mlh.io/events/local-hack-day</link>"
        "<pubDate>Mon, 05 Jan 2026 10:00:00 GMT</pubDate>"
        "<description>one day event</description></item></channel></rss>"
    )
    rows = RssHackathonAdapter.parse_html(feed, "https://mlh.io/events.rss")
    assert len(rows) == 1
    assert rows[0]["name"] == "MLH Local Hack Day"
    assert rows[0]["hackathon_url"] == "https://mlh.io/events/local-hack-day"
    assert rows[0]["year"] == 2026
    assert rows[0]["_extraction"] == "rss"
    # A feed with no usable items yields nothing rather than a placeholder.
    assert RssHackathonAdapter.parse_html("<rss><channel></channel></rss>", "https://x/feed") == []


def test_curated_list_adapter_handles_csv_and_json_dataset_shapes():
    csv_text = 'name,url,start,city,prize\n"Acme Hack",https://acme.io/hack,2027-01-10,Pune,"1 lakh"\n'
    rows = CuratedListAdapter.parse_html(csv_text, "https://raw.example/list.csv")
    assert rows[0]["name"] == "Acme Hack"
    assert rows[0]["year"] == 2027
    assert rows[0]["prize_pool"] == 100000

    json_text = '[{"title": "Beta Jam", "link": "https://beta.io/jam", "start_date": "2027-02-01"}]'
    rows = CuratedListAdapter.parse_html(json_text, "https://raw.example/list.json")
    assert rows[0]["name"] == "Beta Jam"
    assert rows[0]["event_start"].startswith("2027-02-01")

    assert CuratedListAdapter.parse_html("not a dataset", "https://raw.example/x") == []


def test_paused_sources_are_disabled_until_named(monkeypatch):
    for var in ("HACKATHON_RSS_FEEDS", "HACKATHON_LIST_FEEDS", "COLLEGE_DATASET_URLS", "STATE_TPO_URLS"):
        monkeypatch.delenv(var, raising=False)

    default_hackathons = {a.name for a in adapters_for("hackathons")}
    all_hackathons = {a.name for a in adapters_for("hackathons", include_paused=True)}
    assert "codechef_contests" in all_hackathons and "codechef_contests" not in default_hackathons
    assert "hackathon_rss" not in default_hackathons          # no feeds configured
    assert "hackathon_curated_lists" not in default_hackathons
    assert CodeChefContestsAdapter.enabled_by_default is False

    default_colleges = {a.name for a in adapters_for("colleges")}
    all_colleges = {a.name for a in adapters_for("colleges", include_paused=True)}
    for paused in ("careers360", "shiksha", "collegedekho", "collegedunia", "telugucolleges", "ptu_affiliated"):
        assert paused in all_colleges and paused not in default_colleges
    # Enabled by default: official/registry sources only.
    assert {"aishe", "aicte", "ugc", "nirf", "state_portals", "official_sites"} <= default_colleges
    assert Careers360Adapter.enabled_by_default is False

    # Naming a paused source explicitly is how an operator opts in.
    assert [a.name for a in adapters_for("colleges", only=["careers360"])] == ["careers360"]


def test_configured_feeds_are_read_at_call_time_not_frozen_at_import(monkeypatch):
    monkeypatch.setenv("HACKATHON_RSS_FEEDS", "https://a.example/feed.rss, https://b.example/feed.rss")
    assert RssHackathonAdapter().listing_urls == (
        "https://a.example/feed.rss", "https://b.example/feed.rss")
    monkeypatch.setenv("HACKATHON_LIST_FEEDS", "https://raw.example/list.json")
    assert CuratedListAdapter().listing_urls == ("https://raw.example/list.json",)
    monkeypatch.delenv("HACKATHON_RSS_FEEDS")
    monkeypatch.delenv("HACKATHON_LIST_FEEDS")
    assert RssHackathonAdapter().listing_urls == ()
    assert CuratedListAdapter().listing_urls == ()


@pytest.mark.asyncio
async def test_unconfigured_sources_report_unavailable_instead_of_fetching_anything():
    from scrapers.domains.base import SourceTemporarilyUnavailable

    with pytest.raises(SourceTemporarilyUnavailable):
        await StateTpoAdapter().discover()
    with pytest.raises(SourceTemporarilyUnavailable):
        await CollegeDatasetAdapter().discover()


def test_state_tpo_and_dataset_config_parsing():
    parsed = StateTpoAdapter.parse_config("https://a.gov/tpo|Rajasthan,https://b.gov/list")
    assert parsed == [("https://a.gov/tpo", "Rajasthan"), ("https://b.gov/list", None)]
    assert StateTpoAdapter.parse_config("") == []


def test_generic_json_datasets_accept_the_common_key_spellings():
    rows = _parse_generic_json_colleges(
        '[{"college_name": "ABC College", "state_name": "Kerala", "aishe": "C-1234",'
        '  "website": "https://abc.edu", "university": "MG University"},'
        ' {"nothing": "useful"}]',
        "https://raw.example/colleges.json",
    )
    assert len(rows) == 1
    assert rows[0]["name"] == "ABC College"
    assert rows[0]["state"] == "Kerala"
    assert rows[0]["aishe_code"] == "C-1234"
    assert rows[0]["source_url"] == "https://raw.example/colleges.json"


def test_aicte_adapter_defaults_to_public_listing_pages(monkeypatch):
    monkeypatch.delenv("AICTE_LISTING_URLS", raising=False)
    urls = AicteInstitutionsAdapter().urls
    assert urls and all(u.startswith("https://www.aicte-india.org") for u in urls)
    monkeypatch.setenv("AICTE_LISTING_URLS", "https://www.aicte-india.org/other")
    assert AicteInstitutionsAdapter().urls == ["https://www.aicte-india.org/other"]


def test_college_dataset_requires_configuration_to_run():
    adapter = CollegeDatasetAdapter()
    assert adapter.enabled_by_default is False
    assert adapter.verification_note
