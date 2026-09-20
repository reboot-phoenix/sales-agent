"""
Tier 3: RippleHire discovery scraper (India campus/volume-hiring ATS).

RippleHire powers campus + volume hiring for large Indian employers (Tata
Steel, Axis Bank, Mphasis, UST...), but its job boards live on customer
domains — there is NO single stable board API to sweep, and this soldier
will not invent one. Instead it runs keyless DuckDuckGo discovery dorks
over indexed RippleHire pages and turns hits into leads:

  site:ripplehire.com jobs
  ripplehire careers fresher india
  ripplehire campus OR trainee jobs

One cheap HTML fetch per query (html.duckduckgo.com, aiohttp + bs4 — both
already in requirements). A hit becomes a lead only with a fresher/campus/
India signal in title + snippet. Empty result = quiet niche, not a failure.
"""

import re
import asyncio
import aiohttp
import logging
from typing import Any
from urllib.parse import urlparse, parse_qs, unquote

from .base import BaseScraper, ScraperError, now_iso
from .utils.fresher_classifier import is_fresher_role

logger = logging.getLogger(__name__)

DDG_HTML = "https://html.duckduckgo.com/html/?q={q}"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}

QUERIES = [
    "site:ripplehire.com jobs",
    "ripplehire careers fresher india",
    "ripplehire campus OR trainee jobs",
]

MAX_HITS_PER_QUERY = 15

_RELEVANT_RE = re.compile(
    r"fresher|campus|trainee|entry[\s-]?level|intern|0[\s-]*[-–][\s-]*[12]\s*(?:yr|year)"
    r"|graduate|junior|india|bengaluru|hyderabad|mumbai|delhi|chennai|pune|ripplehire",
    re.I,
)
_SPLIT_RE = re.compile(r"\s*[|–—\-:]\s*")


def extract_target(href: str) -> str:
    """Unwrap DDG redirect links (//duckduckgo.com/l/?uddg=<url>) to the target."""
    if not href:
        return ""
    h = href.strip()
    try:
        q = parse_qs(urlparse(h).query)
        if "uddg" in q and q["uddg"]:
            return unquote(q["uddg"][0])
    except Exception:  # noqa: BLE001
        pass
    if h.startswith("//"):
        return "https:" + h
    return h


def parse_ddg_results(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Map raw DDG hits to raw leads with a relevance gate. Pure/testable."""
    leads: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        url = extract_target(str(r.get("href") or ""))
        title = str(r.get("title") or "").strip()
        snippet = str(r.get("snippet") or "").strip()
        if not url.startswith("http") or not title:
            continue
        if url in seen:
            continue
        blob = f"{title} {snippet}"
        if not _RELEVANT_RE.search(blob):
            continue
        seen.add(url)
        host = (urlparse(url).hostname or "").lower()
        parts = [p.strip() for p in _SPLIT_RE.split(title) if p.strip()]
        company = (parts[0] if parts else "")[:120]
        role = (parts[1] if len(parts) > 1 else title)[:160]
        leads.append({
            "company_name": company or host.replace("www.", ""),
            "about_company": "",
            "hr_name": "",
            "hr_email": "",
            "company_email": "",
            "hr_mobile": "",
            "company_mobile": "",
            "hr_linkedin_url": "",
            "job_title": role,
            "about_job": snippet[:1500],
            "experience_required": "",
            "location": "India" if re.search(r"india|bengaluru|hyderabad|mumbai|delhi|chennai|pune", blob, re.I) else "",
            "salary_range": "",
            "job_url": url,
            "source_site": "ripplehire" if "ripplehire" in host else host,
            "scraped_at": now_iso(),
            "is_fresher": is_fresher_role(role, "", blob.lower()),
            "raw_payload": {"title": title, "snippet": snippet[:500]},
        })
    return leads


def _parse_html(html: str) -> list[dict[str, str]]:
    """Extract (href, title, snippet) rows from DDG html endpoint output."""
    try:
        from bs4 import BeautifulSoup
    except Exception:  # noqa: BLE001
        return []
    soup = BeautifulSoup(html, "html.parser")
    rows: list[dict[str, str]] = []
    for node in soup.select(".result"):
        a = node.select_one(".result__a")
        if not a:
            continue
        sn = node.select_one(".result__snippet")
        rows.append({
            "href": a.get("href", ""),
            "title": a.get_text(" ", strip=True),
            "snippet": sn.get_text(" ", strip=True) if sn else "",
        })
    return rows


class RippleHireScraper(BaseScraper):
    source_name = "ripplehire"
    tier = 3
    rate_limit_seconds = 2.0
    API_URL = "https://html.duckduckgo.com"  # robots pre-check target

    async def scrape(self) -> list[dict[str, Any]]:
        from urllib.parse import quote_plus
        all_rows: list[dict[str, str]] = []
        try:
            async with aiohttp.ClientSession() as session:
                for q in QUERIES:
                    try:
                        async with session.get(
                            DDG_HTML.format(q=quote_plus(q)),
                            headers=UA,
                            timeout=aiohttp.ClientTimeout(total=20),
                        ) as resp:
                            if resp.status != 200:
                                continue
                            body = await resp.text()
                    except Exception as e:  # noqa: BLE001
                        self._logger.warning(f"RippleHire dork failed '{q}': {e}")
                        continue
                    all_rows.extend(_parse_html(body))
                    await asyncio.sleep(self.rate_limit_seconds)
        except Exception as e:  # noqa: BLE001
            raise ScraperError(f"ripplehire fetch failed: {e}")
        leads = parse_ddg_results(all_rows)
        self._logger.info(f"RippleHire: scraped {len(leads)} raw leads")
        return leads
