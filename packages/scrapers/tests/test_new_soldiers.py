"""
New-soldier tests: HackerNews Who's Hiring, RippleHire discovery, FreshersVoice.
All offline/deterministic (inline fixtures, no live network).
"""
import pytest

from datetime import datetime, timezone

from scrapers.hackernews import find_latest_thread, parse_comment
from scrapers.ripplehire import parse_ddg_results, extract_target


def _comment(cid, text, author="poster", created="2026-09-01T00:00:00Z"):
    return {"id": cid, "author": author, "text": text, "created_at": created,
            "children": []}


# ---------- HackerNews thread picking ----------

def test_find_latest_thread_picks_newest_whoishiring():
    hits = [
        {"objectID": "1", "author": "someone", "title": "Ask HN: Who is hiring?",
         "created_at_i": 999, "story_id": 1},
        {"objectID": "2", "author": "whoishiring", "title": "Ask HN: Who is hiring? (Jan)",
         "created_at_i": 100, "story_id": 2},
        {"objectID": "3", "author": "whoishiring", "title": "Ask HN: Who is hiring? (Sep)",
         "created_at_i": 300, "story_id": 3},
    ]
    assert find_latest_thread(hits) == 3


def test_find_latest_thread_none_without_whoishiring():
    assert find_latest_thread([{"author": "x", "title": "Who is hiring?",
                                "created_at_i": 1, "story_id": 9}]) is None
    assert find_latest_thread([]) is None


# ---------- HackerNews comment parsing ----------

def test_parse_comment_intern_remote_kept_with_email():
    c = _comment(11, "Acme Corp | Backend Intern | REMOTE | Apply: jobs@acme.dev")
    lead = parse_comment(c)
    assert lead is not None
    assert lead["company_name"] == "Acme Corp"
    assert lead["hr_email"] == "jobs@acme.dev"
    assert lead["job_url"] == "https://news.ycombinator.com/item?id=11"
    assert lead["source_site"] == "news.ycombinator.com"
    assert "REMOTE" in (lead["location"] or "").upper()


def test_parse_comment_senior_us_dropped():
    c = _comment(12, "BigCo | Senior Staff Engineer | ONSITE San Francisco | $400k")
    assert parse_comment(c) is None


def test_parse_comment_india_fresher_kept_no_email():
    c = _comment(13, "StartupXYZ | Graduate Trainee Engineer | Bengaluru, India ONSITE")
    lead = parse_comment(c)
    assert lead is not None
    assert lead["hr_email"] == ""
    assert "Bengaluru" in lead["location"]


def test_parse_comment_empty_or_deleted_dropped():
    assert parse_comment(_comment(14, "")) is None
    assert parse_comment({"id": 15}) is None


# ---------- RippleHire discovery parsing ----------

def test_parse_ddg_results_keeps_fresher_hits():
    rows = [
        {"href": "https://jobs.ripplehire.com/abc", "title": "Acme - Software Trainee | RippleHire",
         "snippet": "Fresher campus drive for 2026 batch in India. Apply now."},
        {"href": "https://example.com/senior-vp-sales", "title": "Senior VP Sales",
         "snippet": "10+ years experience required."},
    ]
    leads = parse_ddg_results(rows)
    assert len(leads) == 1
    assert leads[0]["job_url"] == "https://jobs.ripplehire.com/abc"
    assert leads[0]["source_site"] == "ripplehire"


def test_extract_target_unwraps_ddg_redirect():
    href = "//duckduckgo.com/l/?uddg=" + "https%3A%2F%2Fjobs.ripplehire.com%2Fxyz&rut=abc"
    assert extract_target(href) == "https://jobs.ripplehire.com/xyz"
    assert extract_target("https://jobs.ripplehire.com/direct") == "https://jobs.ripplehire.com/direct"
    assert extract_target("") == ""


# ---------- FreshersVoice wiring ----------

def test_freshersvoice_in_offcampus_sites():
    from scrapers.offcampus_aggregators import SITES
    keys = [s["key"] for s in SITES]
    assert "freshersvoice" in keys
    fv = next(s for s in SITES if s["key"] == "freshersvoice")
    assert fv["sitemap"].startswith("https://")
    assert "freshersvoice" in fv["source_site"]


def test_new_soldiers_registered():
    from scrapers.scrape_consumer import SCRAPER_MAP, DEFAULT_SOURCES
    assert "hackernews" in SCRAPER_MAP
    assert "ripplehire" in SCRAPER_MAP
    assert "hackernews" in DEFAULT_SOURCES
    assert "ripplehire" in DEFAULT_SOURCES


# ---------- Stored freshness helpers ----------

def test_freshness_for_boundaries():
    from datetime import timedelta
    from scrapers.normalizer import freshness_for
    now = datetime.now(timezone.utc)
    assert freshness_for(None) == "unknown"
    assert freshness_for(now - timedelta(hours=3), now) == "fresh"
    assert freshness_for(now - timedelta(days=4), now) == "recent"
    assert freshness_for(now - timedelta(days=12), now) == "older"
    assert freshness_for(now + timedelta(hours=1), now) == "fresh"


def test_freshness_case_sql_guards_null():
    from scrapers.normalizer import freshness_case_sql
    sql = freshness_case_sql("$21")
    assert "$21" in sql
    assert "'unknown'" in sql and "'fresh'" in sql
    assert "'recent'" in sql and "'older'" in sql
    assert "24 hours" in sql and "7 days" in sql


# ---------- Nightly freshness refresh ----------

class _Conn:
    def __init__(self):
        self.statements = []

    async def execute(self, sql):
        self.statements.append(sql)
        return "UPDATE 7"


class _Pool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        parent = self

        class _Ctx:
            async def __aenter__(self):
                return parent._conn

            async def __aexit__(self, *a):
                return False

        return _Ctx()


@pytest.mark.asyncio
async def test_refresh_freshness_updates_and_counts():
    from scrapers import scheduler as sched
    conn = _Conn()
    n = await sched.refresh_freshness(_Pool(conn))
    assert n == 7
    assert len(conn.statements) == 1
    assert "freshness_category" in conn.statements[0]
    assert "IS DISTINCT FROM" in conn.statements[0]


@pytest.mark.asyncio
async def test_refresh_freshness_no_pool_is_zero():
    from scrapers import scheduler as sched
    assert await sched.refresh_freshness(None) == 0
