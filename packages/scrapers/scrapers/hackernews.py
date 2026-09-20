"""
Tier 2: HackerNews "Who is hiring?" monthly thread scraper.

Verified live 2026-09-20: the public, keyless Algolia API
  GET https://hn.algolia.com/api/v1/search_by_date?query=who+is+hiring&tags=story
returns story hits; the newest hit authored by `whoishiring` is the current
monthly thread, and GET /api/v1/items/{story_id} returns its top-level
comments — first-party job posts written by the hiring companies themselves
(often WITH a contact email in the post: enrichment gold).

Hard relevance gate: HN skews senior/US, so a comment becomes a lead only if
it signals fresher/intern/entry-level OR India. Everything else is skipped —
volume without relevance is noise.
"""

import re
import html as _html
import asyncio
import aiohttp
import logging
from typing import Any

from .base import BaseScraper, ScraperError, now_iso
from .utils.fresher_classifier import is_fresher_role

logger = logging.getLogger(__name__)

API_URL = "https://hn.algolia.com/api/v1"
SEARCH_URL = (
    API_URL + "/search_by_date?query=who%20is%20hiring&tags=story&hitsPerPage=30"
)
ITEM_URL = API_URL + "/items/{story_id}"
THREAD_URL = "https://news.ycombinator.com/item?id={cid}"

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

MAX_COMMENTS = 80
MAX_TEXT = 1500

# India signals (cities + country variants hiring posts actually use).
_INDIA_RE = re.compile(
    r"\bindia\b|bengaluru|bangalore|hyderabad|mumbai|delhi|ncr|chennai|pune|"
    r"kolkata|ahmedabad|kochi|gurgaon|gurugram|noida|jaipur|indore|surat",
    re.I,
)
# Junior signals beyond the shared classifier (HN posts say INTERN/VISA/REMOTE).
_JUNIOR_RE = re.compile(
    r"\bintern(?:ship|s)?\b|fresher|entry[\s-]?level|grad(?:uate)?\s+(?:trainee|engineer|hire)"
    r"|trainee|0[\s-]*[-–][\s-]*[12]\s*(?:yr|year)|campus\s+hire|new\s+grad|junior",
    re.I,
)
_REMOTE_RE = re.compile(r"\bREMOTE\b")
_ONSITE_RE = re.compile(r"\bONSITE\b")


def _clean(text: str) -> str:
    """Strip HN comment HTML to plain text. Pure/offline-testable."""
    if not text:
        return ""
    s = _TAG_RE.sub(" ", text)
    s = _html.unescape(s)
    return _WS_RE.sub(" ", s).strip()


def find_latest_thread(hits: list[dict[str, Any]]) -> int | None:
    """Newest story_id authored by `whoishiring` with 'hiring' in the title."""
    best_id: int | None = None
    best_ts = -1
    for h in hits or []:
        if not isinstance(h, dict):
            continue
        if (h.get("author") or "") != "whoishiring":
            continue
        if "hiring" not in str(h.get("title") or "").lower():
            continue
        try:
            ts = int(h.get("created_at_i") or 0)
            sid = int(h.get("story_id") or h.get("objectID") or 0)
        except (TypeError, ValueError):
            continue
        if sid and ts >= best_ts:
            best_ts = ts
            best_id = sid
    return best_id


def parse_comment(comment: dict[str, Any]) -> dict[str, Any] | None:
    """Map one top-level thread comment to a raw lead, or None to skip."""
    if not isinstance(comment, dict):
        return None
    cid = comment.get("id")
    text = _clean(str(comment.get("text") or ""))
    if not cid or not text:
        return None

    junior = bool(_JUNIOR_RE.search(text))
    india = bool(_INDIA_RE.search(text))
    if not (junior or india):
        return None

    # First line is conventionally "Company | Role | Location | ...".
    first = text.split("\n")[0] if "\n" in text else text[:160]
    parts = [p.strip() for p in re.split(r"\s*[|]\s*", first) if p.strip()]
    company = (parts[0] if parts else "")[:120]
    role = (parts[1] if len(parts) > 1 else "")[:160]

    emails = EMAIL_RE.findall(text)
    email = emails[0].strip().lower() if emails else ""

    loc_bits: list[str] = []
    if _REMOTE_RE.search(text):
        loc_bits.append("Remote")
    if _ONSITE_RE.search(text):
        loc_bits.append("On-site")
    m = _INDIA_RE.search(text)
    if m:
        loc_bits.append(m.group(0).title())
    location = ", ".join(loc_bits)

    # Honest partial data: HN posts rarely name a formal title.
    title = role or ("Fresher/Intern opening (see post)" if junior else "Opening in India (see post)")
    blob = text.lower()

    return {
        "company_name": company or "HN hiring post",
        "about_company": "",
        "hr_name": "",
        "hr_email": email,  # first-party address printed in the hiring post
        "company_email": "",
        "hr_mobile": "",
        "company_mobile": "",
        "hr_linkedin_url": "",
        "job_title": title,
        "about_job": text[:MAX_TEXT],
        "experience_required": "",
        "location": location,
        "salary_range": "",
        "job_url": THREAD_URL.format(cid=cid),
        "source_site": "news.ycombinator.com",
        "scraped_at": now_iso(),
        "is_fresher": is_fresher_role(title, "", blob),
        "raw_payload": {"comment_id": cid, "author": comment.get("author"),
                        "created_at": comment.get("created_at")},
    }


class HackerNewsScraper(BaseScraper):
    source_name = "hackernews"
    tier = 2
    rate_limit_seconds = 1.0
    API_URL = API_URL  # robots pre-check target

    async def scrape(self) -> list[dict[str, Any]]:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    SEARCH_URL,
                    headers={"User-Agent": "HireGen-LeadGen/1.0"},
                    timeout=aiohttp.ClientTimeout(total=20),
                ) as resp:
                    if resp.status != 200:
                        raise ScraperError(f"HN search returned {resp.status}")
                    data = await resp.json(content_type=None)
                story_id = find_latest_thread((data or {}).get("hits") or [])
                if not story_id:
                    return []
                await asyncio.sleep(self.rate_limit_seconds)
                async with session.get(
                    ITEM_URL.format(story_id=story_id),
                    headers={"User-Agent": "HireGen-LeadGen/1.0"},
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp2:
                    if resp2.status != 200:
                        raise ScraperError(f"HN items returned {resp2.status}")
                    thread = await resp2.json(content_type=None)
        except ScraperError:
            raise
        except Exception as e:  # noqa: BLE001
            raise ScraperError(f"hackernews fetch failed: {e}")

        leads: list[dict[str, Any]] = []
        for child in ((thread or {}).get("children") or [])[:MAX_COMMENTS]:
            try:
                lead = parse_comment(child)
            except Exception:  # noqa: BLE001  (one bad comment never sinks the run)
                continue
            if lead:
                leads.append(lead)
        self._logger.info(f"HackerNews: scraped {len(leads)} raw leads")
        return leads
