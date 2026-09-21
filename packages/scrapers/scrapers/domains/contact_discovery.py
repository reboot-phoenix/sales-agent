"""Finding where a person is listed — the fallback chain for contact pages.

A single guessed path is a weak enrichment strategy: plenty of Indian colleges
put their TPO on `/training-and-placement-cell/`, `/placement-cell/` or a page
linked only from the navigation. This module therefore builds the candidate list
in three widening passes, all against the entity's own official domain:

1. **Known paths** — the common placement/administration/contact URL shapes.
2. **Sitemap** — if the site publishes `sitemap.xml` (or lists it in robots.txt),
   filter its URLs for role keywords. This finds pages nobody could guess.
3. **Navigation links** — fetch the homepage and follow anchors whose href or
   link text mentions a role ("Training & Placement", "Principal", ...).

Every pass is bounded, same-domain only, de-duplicated, and read-only: only
public pages are fetched, and no login/paywall/private page is ever requested.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urljoin, urlparse

from .normalize import clean_text, extract_domain

logger = logging.getLogger(__name__)

Fetch = Callable[..., Awaitable[Any]]

# Pages where role contacts usually live, appended to the official site root.
CONTACT_PATHS: tuple[str, ...] = (
    "",
    "/contact",
    "/contact-us",
    "/contactus",
    "/reach-us",
    "/placement",
    "/placements",
    "/placement-cell",
    "/training-and-placement",
    "/training-placement",
    "/training-and-placement-cell",
    "/training-placement-cell",
    "/placement-office",
    "/tpo",
    "/tpo-desk",
    "/careers",
    "/recruiters",
    "/administration",
    "/administrative-office",
    "/principal",
    "/principal-office",
    "/director",
    "/dean",
    "/registrar",
    "/faculty",
    "/faculty-directory",
    "/staff",
    "/people",
    "/our-team",
    "/about/contact",
    "/about-us/contact",
    "/departments/placement",
)

# Keywords that mark a URL or link text as worth fetching for a person.
ROLE_LINK_HINTS: tuple[str, ...] = (
    "placement", "training", "tpo", "principal", "director", "dean", "hod",
    "registrar", "faculty", "staff", "contact", "administration", "office",
    "admission", "people", "team", "about",
)

_SKIP_URL_PARTS = (
    "/login", "/signin", "/sign-in", "/register", "/cart", "/checkout",
    "/events?", "/news", "/blog", "/gallery", "/media", "/press",
)
_DOC_SUFFIXES = (".pdf", ".jpg", ".png", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".mp4")

# The candidate list is deliberately finite: a sweep checks the pages people
# actually publish roles on, not the whole site. Enrichment additionally caps how
# many of these it fetches per run.
MAX_CANDIDATE_URLS = 40


def candidate_contact_urls(website_url: Optional[str]) -> list[str]:
    """Pass 1: the bounded list of common public pages to check."""
    domain = extract_domain(website_url)
    if not domain:
        return []
    root = f"https://{domain}"
    seen: list[str] = []
    for path in CONTACT_PATHS:
        url = f"{root}{path}"
        if url not in seen:
            seen.append(url)
    return seen[:MAX_CANDIDATE_URLS]


def _same_site(candidate: str, domain: str) -> bool:
    host = (urlparse(candidate).netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host == domain or host.endswith(f".{domain}")


def _is_worth_fetching(url: str) -> bool:
    lowered = url.lower()
    if any(suffix in lowered for suffix in _DOC_SUFFIXES):
        return False
    if any(part in lowered for part in _SKIP_URL_PARTS):
        return False
    return True


def _hits_role_hint(text: str) -> bool:
    lowered = text.lower()
    return any(hint in lowered for hint in ROLE_LINK_HINTS)


def extract_role_links(html: str, base_url: str, *, limit: int = 12) -> list[str]:
    """Pass 3 input: anchors on a page whose href/text points at a role page."""
    if not html:
        return []
    domain = extract_domain(base_url)
    if not domain:
        return []
    found: list[str] = []
    for match in re.finditer(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]{0,120}?)</a>", html, re.I):
        href, text = match.group(1), clean_text(match.group(2), 120)
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = urljoin(base_url, href)
        if not absolute.startswith(("http://", "https://")):
            continue
        if not _same_site(absolute, domain) or not _is_worth_fetching(absolute):
            continue
        if _hits_role_hint(href) or _hits_role_hint(text):
            clean = absolute.split("#", 1)[0]
            if clean not in found:
                found.append(clean)
        if len(found) >= limit:
            break
    return found


def parse_sitemap_urls(xml: str, *, limit: int = 200) -> dict[str, Any]:
    """Sitemap/robots parsing kept pure so it can be tested without a network.

    Returns ``{"urls": [...]}`` plus ``{"nested": [...]}`` for sitemap indexes.
    """
    if not xml:
        return {"urls": [], "nested": []}
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml, re.I)
    if not locs:
        # robots.txt style ("Sitemap: https://..." lines)
        locs = re.findall(r"(?im)^sitemap:\s*(\S+)", xml)
    # A .xml loc is itself a sitemap to fetch (sitemap index, or a robots.txt
    # Sitemap: line), never an item page — so it is returned as nested, not as a
    # candidate contact URL.
    nested = [loc for loc in locs if loc.lower().endswith(".xml")]
    urls = [loc for loc in locs if loc not in nested][:limit]
    return {"urls": urls, "nested": nested[:5]}


async def discover_sitemap_urls(
    website_url: Optional[str],
    *,
    fetch: Optional[Fetch] = None,
    limit: int = 12,
    timeout: int = 20,
) -> list[str]:
    """Pass 2: role-relevant URLs from the site's own sitemap, if it has one."""
    domain = extract_domain(website_url)
    if not domain:
        return []
    fetcher = fetch or _default_fetch()
    found: list[str] = []
    for sitemap in (f"https://{domain}/sitemap.xml", f"https://{domain}/robots.txt", f"https://{domain}/sitemap_index.xml"):
        try:
            resp = await fetcher(sitemap, timeout=timeout, min_engine="httpx", max_engine="httpx")
        except Exception as e:  # noqa: BLE001 - a missing sitemap is normal
            logger.debug("sitemap probe failed %s: %s", sitemap, e)
            continue
        if getattr(resp, "status", 0) != 200 or not getattr(resp, "text", ""):
            continue
        parsed = parse_sitemap_urls(resp.text)
        for nested in parsed["nested"]:
            if not _same_site(nested, domain):
                continue
            try:
                nested_resp = await fetcher(nested, timeout=timeout, min_engine="httpx", max_engine="httpx")
            except Exception as e:  # noqa: BLE001
                logger.debug("nested sitemap failed %s: %s", nested, e)
                continue
            if getattr(nested_resp, "status", 0) == 200 and getattr(nested_resp, "text", ""):
                parsed["urls"].extend(parse_sitemap_urls(nested_resp.text)["urls"])
        for url in parsed["urls"]:
            if not _same_site(url, domain) or not _is_worth_fetching(url):
                continue
            if _hits_role_hint(url) and url not in found:
                found.append(url)
            if len(found) >= limit:
                return found
        if found:
            return found
    return found


async def discover_contact_urls(
    website_url: Optional[str],
    *,
    fetch: Optional[Fetch] = None,
    limit: int = MAX_CANDIDATE_URLS,
    timeout: int = 20,
) -> list[str]:
    """The full, bounded fallback chain of public pages to try, in order."""
    domain = extract_domain(website_url)
    if not domain:
        return []
    total = max(1, min(limit, MAX_CANDIDATE_URLS))
    # Known paths lead the list; anything discovered is appended and the whole
    # result is capped, so a caller always gets a bounded, ordered plan.
    base = candidate_contact_urls(website_url)[:total]
    remaining = max(0, total - len(base))
    discovered: list[str] = []
    if remaining:
        fetcher = fetch or _default_fetch()
        try:
            discovered = await discover_sitemap_urls(website_url, fetch=fetcher, limit=remaining, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            logger.debug("sitemap discovery failed for %s: %s", domain, e)
        if len(discovered) < remaining:
            # Pass 3: follow role links from the homepage itself.
            try:
                resp = await fetcher(f"https://{domain}/", timeout=timeout, min_engine="httpx", max_engine="httpx")
                if getattr(resp, "status", 0) == 200 and getattr(resp, "text", ""):
                    for url in extract_role_links(resp.text, f"https://{domain}/", limit=remaining):
                        if url not in discovered and url not in base:
                            discovered.append(url)
            except Exception as e:  # noqa: BLE001
                logger.debug("homepage link discovery failed for %s: %s", domain, e)
    out = list(base)
    for url in discovered:
        if url not in out:
            out.append(url)
    return out[:total]


def _default_fetch() -> Fetch:
    from ..utils.http_client import fetch

    return fetch
