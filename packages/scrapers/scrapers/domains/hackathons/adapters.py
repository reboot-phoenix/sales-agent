"""Hackathon source adapters.

Each adapter targets ONE publicly accessible source and exposes a pure
``parse_<source>()`` classmethod so the extraction rules can be unit-tested
offline against captured fixtures. ``discover()`` only adds the network hop.

Only public listing/JSON endpoints and on-page structured data are read: no
logins, no CAPTCHA solving, no private profiles, and no circumvention of access
controls. Provenance (source_url + source_platform + method) travels with every
record.

Verification honesty: the request shapes below reflect each platform's public
surface, but live network access is not available inside CI, so the endpoints
themselves are marked EXTERNAL_DEPENDENCY in docs — the parsers are what is
tested here.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

from ..base import RawDiscovery, SourceAdapter, SourceTemporarilyUnavailable
from ..normalize import (
    as_list,
    clean_text,
    extract_domain,
    parse_bool,
    parse_date_range,
    parse_datetime,
    parse_money,
    strip_html,
)

_JSONLD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.I | re.S,
)


def extract_json_ld(html: str) -> list[Any]:
    """Return every parsed JSON-LD block on a page (tolerating a bad block)."""
    out: list[Any] = []
    for block in _JSONLD_RE.findall(html or ""):
        try:
            out.append(json.loads(block.strip()))
        except (json.JSONDecodeError, TypeError):
            continue
    return out


def find_key_list(data: Any, keys: tuple[str, ...]) -> list[dict]:
    """Find the first list-of-dicts under any of `keys`, at any nesting depth.

    Boards wrap their payload differently run to run ('data', 'results',
    'hackathons', 'data.data', ...). Rather than coding one brittle path per
    source, walk the structure and return the first suitable list.
    """
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list) and value and isinstance(value[0], dict):
                return value
        for value in data.values():
            found = find_key_list(value, keys)
            if found:
                return found
    return []


def _split_period(value: Any) -> tuple[Optional[Any], Optional[Any]]:
    return parse_date_range(value)


class DevpostAdapter(SourceAdapter):
    """Devpost public hackathon listing API (no auth)."""

    domain = "hackathons"
    name = "devpost"
    display_name = "Devpost"
    tier = 1
    base_url = "https://devpost.com"
    service = "https://devpost.com/api/hackathons"

    verification_note = (
        "Public JSON listing endpoint; parser unit-tested offline. Live HTTP not "
        "exercised in CI (EXTERNAL_DEPENDENCY)."
    )

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        for page in (1, 2, 3):
            url = f"{self.service}?page={page}&per_page=24&status[]=open&status[]=upcoming"
            resp = await fetch(url, timeout=25, headers={"Accept": "application/json"},
                               min_engine="httpx", max_engine="curl")
            if resp.status != 200:
                if page == 1:
                    raise SourceTemporarilyUnavailable(f"devpost HTTP {resp.status}")
                break
            try:
                data = json.loads(resp.text)
            except (json.JSONDecodeError, TypeError):
                break
            items = find_key_list(data, ("hackathons", "results", "data"))
            if not items:
                break
            for item in items:
                parsed = self.parse_item(item)
                if parsed:
                    records.append(RawDiscovery(
                        source=self.name,
                        payload=parsed,
                        source_url=parsed.get("hackathon_url"),
                        extraction_method="api_json",
                    ))
        return records

    @classmethod
    def parse_item(cls, item: dict) -> Optional[dict]:
        name = clean_text(item.get("title") or item.get("name"))
        if not name:
            return None
        url = clean_text(item.get("url") or item.get("hackathon_url"))
        open_state = clean_text(item.get("open_state") or item.get("state")).lower()
        start, end = _split_period(item.get("submission_period_dates") or item.get("dates"))
        location = item.get("displayed_location")
        city = state = None
        mode = None
        if isinstance(location, dict):
            loc_text = clean_text(location.get("location") or location.get("name"))
        else:
            loc_text = clean_text(location)
        if loc_text:
            if "online" in loc_text.lower():
                mode = "online"
            else:
                # A stated place means the event is not fully remote — that is
                # an observation from the source, not an inference.
                mode = "offline"
                if "," in loc_text:
                    bits = [b.strip() for b in loc_text.split(",") if b.strip()]
                    city = bits[-2] if len(bits) >= 2 else None
                    state = bits[-1] if bits else None
                else:
                    city = loc_text
        themes = [clean_text(t.get("name")) for t in (item.get("themes") or []) if isinstance(t, dict)]
        # Devpost exposes only a submission window; the registration deadline is
        # the same window close, which is an honest statement, not an invention.
        return {
            "name": name,
            "hackathon_url": url,
            "source_url": url,
            "source_platform": "devpost.com",
            "organization_description": "",
            "organizer_name": clean_text(item.get("organization_name")),
            "event_type": "hackathon",
            "hackathon_type": "online_challenge" if mode == "online" else "onsite",
            "mode": mode,
            "city": city,
            "state": state,
            "registration_deadline": end.isoformat() if end else None,
            "event_start": None,
            "event_end": end.isoformat() if end else None,
            "themes": themes,
            "technology": ", ".join(themes[:3]) if themes else None,
            "domain": themes[0] if themes else None,
            "tags": ["devpost"],
            "prize_pool": cls._prize_total(item.get("prizes")),
            "open_to_public": True,
            "status": {"open": "REGISTRATION_OPEN", "upcoming": "ANNOUNCED",
                       "ended": "HISTORICAL"}.get(open_state),
            "year": end.year if end else (start.year if start else None),
            "raw_payload": item,
        }

    @staticmethod
    def _prize_total(prizes: Any) -> Optional[float]:
        if not isinstance(prizes, list):
            return None
        totals = []
        for prize in prizes:
            if not isinstance(prize, dict):
                continue
            amount = parse_money(prize.get("amount") or prize.get("value") or prize.get("cash"))
            if amount:
                totals.append(amount)
        return max(totals) if totals else None


class UnstopHackathonAdapter(SourceAdapter):
    """Unstop public opportunity search API filtered to hackathons."""

    domain = "hackathons"
    name = "unstop_hackathons"
    display_name = "Unstop (hackathons)"
    tier = 1
    base_url = "https://unstop.com"
    service = "https://unstop.com/api/public/opportunity/search-result"

    verification_note = "Public JSON search API; parser unit-tested offline (EXTERNAL_DEPENDENCY for live HTTP)."

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        for page in (1, 2, 3):
            url = f"{self.service}?opportunity=hackathons&page={page}&perPage=20&locations=india"
            resp = await fetch(url, timeout=25, headers={"Accept": "application/json"},
                               min_engine="httpx", max_engine="curl")
            if resp.status != 200:
                if page == 1:
                    raise SourceTemporarilyUnavailable(f"unstop HTTP {resp.status}")
                break
            try:
                data = json.loads(resp.text)
            except (json.JSONDecodeError, TypeError):
                break
            items = find_key_list(data, ("data", "results"))
            if not items:
                break
            for item in items:
                parsed = self.parse_item(item)
                if parsed:
                    records.append(RawDiscovery(
                        source=self.name, payload=parsed,
                        source_url=parsed.get("hackathon_url"), extraction_method="api_json",
                    ))
        return records

    @classmethod
    def parse_item(cls, item: dict) -> Optional[dict]:
        name = clean_text(item.get("title") or item.get("name"))
        if not name:
            return None
        seo = clean_text(item.get("seo_url") or item.get("public_url"))
        url = seo if seo.startswith("http") else (f"https://unstop.com/{seo.lstrip('/')}" if seo else "")
        org = item.get("organisation") if isinstance(item.get("organisation"), dict) else {}
        locs = item.get("locations") or []
        loc0 = locs[0] if locs and isinstance(locs[0], dict) else {}
        start, end = _split_period(
            (item.get("hackathonDetail") or {}).get("start_date")
            if isinstance(item.get("hackathonDetail"), dict) else item.get("start_date")
        )
        reg_end = None
        detail = item.get("hackathonDetail") if isinstance(item.get("hackathonDetail"), dict) else {}
        for key in ("end_date", "registration_end", "deadline"):
            reg_end = parse_datetime(detail.get(key) if detail else item.get(key))
            if reg_end:
                break
        mode = None
        if parse_bool(item.get("is_online")) is True:
            mode = "online"
        return {
            "name": name,
            "hackathon_url": url,
            "source_url": url,
            "source_platform": "unstop.com",
            "organizer_name": clean_text(org.get("name") or item.get("organisation_name")),
            "organizer_website": clean_text(org.get("website")),
            "organization_description": strip_html(org.get("about"), 800),
            "event_type": "hackathon",
            "hackathon_type": "virtual" if mode == "online" else None,
            "mode": mode,
            "city": clean_text(loc0.get("city")),
            "state": clean_text(loc0.get("state")),
            "country": clean_text(loc0.get("country")) or "India",
            "registration_start": start.isoformat() if start else None,
            "registration_deadline": reg_end.isoformat() if reg_end else None,
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "prize_pool": parse_money(
                detail.get("prize") or item.get("prize") or item.get("prize_money")
            ),
            "eligibility": clean_text(detail.get("eligibility") or item.get("eligibility"), 500),
            "student_only": parse_bool(item.get("is_student_only")),
            "tags": ["unstop"],
            "status": "REGISTRATION_OPEN",
            "year": (reg_end or start).year if (reg_end or start) else None,
            "raw_payload": item,
        }


class MlhAdapter(SourceAdapter):
    """Major League Hacking public season events page (JSON-LD)."""

    domain = "hackathons"
    name = "mlh"
    display_name = "Major League Hacking"
    tier = 2
    base_url = "https://mlh.io"
    service = "https://mlh.io/seasons/2026/events"

    verification_note = "Structured data on a public events page; parser unit-tested offline (EXTERNAL_DEPENDENCY for live HTTP)."

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        resp = await fetch(self.service, timeout=30, min_engine="httpx", max_engine="playwright")
        if resp.status != 200 or not resp.text:
            raise SourceTemporarilyUnavailable(f"mlh HTTP {resp.status}")
        records: list[RawDiscovery] = []
        for parsed in self.parse_html(resp.text):
            records.append(RawDiscovery(
                source=self.name, payload=parsed,
                source_url=parsed.get("hackathon_url"), extraction_method="json_ld",
            ))
        return records

    @classmethod
    def parse_html(cls, html: str) -> list[dict]:
        out: list[dict] = []
        for block in extract_json_ld(html):
            events = block if isinstance(block, list) else [block]
            for event in events:
                if not isinstance(event, dict):
                    continue
                if str(event.get("@type", "")).lower() not in ("event", "hackathonevent"):
                    continue
                parsed = cls.parse_event(event)
                if parsed:
                    out.append(parsed)
        return out

    @classmethod
    def parse_event(cls, event: dict) -> Optional[dict]:
        name = clean_text(event.get("name"))
        if not name:
            return None
        location = event.get("location") if isinstance(event.get("location"), dict) else {}
        address = location.get("address") if isinstance(location.get("address"), dict) else {}
        start = parse_datetime(event.get("startDate"))
        end = parse_datetime(event.get("endDate"))
        online = str(event.get("eventAttendanceMode") or "").lower()
        mode = "online" if "online" in online else ("offline" if location else None)
        organizer = event.get("organizer") if isinstance(event.get("organizer"), dict) else {}
        return {
            "name": name,
            "hackathon_url": clean_text(event.get("url")),
            "source_url": clean_text(event.get("url")),
            "source_platform": "mlh.io",
            "organizer_name": clean_text(organizer.get("name")) or "Major League Hacking",
            "organizer_website": clean_text(organizer.get("url")),
            "organizer_type": "community",
            "event_type": "hackathon",
            "hackathon_type": "hybrid" if mode else None,
            "mode": mode,
            "venue": clean_text(address.get("streetAddress")),
            "city": clean_text(address.get("addressLocality")),
            "state": clean_text(address.get("addressRegion")),
            "country": clean_text(address.get("addressCountry")),
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "student_only": True,
            "college_only": True,
            "open_to_public": False,
            "tags": ["mlh", "student"],
            "status": "ANNOUNCED",
            "year": start.year if start else None,
            "raw_payload": event,
        }


class DevfolioAdapter(SourceAdapter):
    """Devfolio public hackathons page (embedded JSON / JSON-LD)."""

    domain = "hackathons"
    name = "devfolio"
    display_name = "Devfolio"
    tier = 2
    base_url = "https://devfolio.co"
    service = "https://devfolio.co/hackathons"

    verification_note = "Public page structured data; parser unit-tested offline (EXTERNAL_DEPENDENCY for live HTTP)."

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        resp = await fetch(self.service, timeout=30, min_engine="curl", max_engine="playwright")
        if resp.status != 200 or not resp.text:
            raise SourceTemporarilyUnavailable(f"devfolio HTTP {resp.status}")
        return [
            RawDiscovery(source=self.name, payload=p, source_url=p.get("hackathon_url"),
                         extraction_method="embedded_json")
            for p in self.parse_html(resp.text)
        ]

    @classmethod
    def parse_html(cls, html: str) -> list[dict]:
        out: list[dict] = []
        for block in extract_json_ld(html):
            for event in (block if isinstance(block, list) else [block]):
                if isinstance(event, dict) and str(event.get("@type", "")).lower().endswith("event"):
                    parsed = cls.parse_event(event)
                    if parsed:
                        out.append(parsed)
        # Next.js pages embed the same records under __NEXT_DATA__.
        m = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html or "", re.I | re.S)
        if m:
            try:
                data = json.loads(m.group(1))
            except (json.JSONDecodeError, TypeError):
                data = None
            for item in find_key_list(data, ("hackathons", "events", "results")):
                parsed = cls.parse_next_item(item)
                if parsed:
                    out.append(parsed)
        return out

    @classmethod
    def parse_event(cls, event: dict) -> Optional[dict]:
        name = clean_text(event.get("name"))
        if not name:
            return None
        start = parse_datetime(event.get("startDate"))
        end = parse_datetime(event.get("endDate"))
        return {
            "name": name,
            "hackathon_url": clean_text(event.get("url")),
            "source_url": clean_text(event.get("url")),
            "source_platform": "devfolio.co",
            "organizer_name": clean_text((event.get("organizer") or {}).get("name"))
            if isinstance(event.get("organizer"), dict) else None,
            "event_type": "hackathon",
            "mode": "online" if "online" in str(event.get("eventAttendanceMode") or "").lower() else None,
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "tags": ["devfolio"],
            "status": "ANNOUNCED",
            "year": start.year if start else None,
            "raw_payload": event,
        }

    @classmethod
    def parse_next_item(cls, item: dict) -> Optional[dict]:
        name = clean_text(item.get("name") or item.get("title"))
        if not name:
            return None
        start = parse_datetime(item.get("starts_at") or item.get("start_date"))
        end = parse_datetime(item.get("ends_at") or item.get("end_date"))
        slug = clean_text(item.get("slug"))
        return {
            "name": name,
            "hackathon_url": f"https://devfolio.co/hackathons/{slug}" if slug else None,
            "source_url": f"https://devfolio.co/hackathons/{slug}" if slug else None,
            "source_platform": "devfolio.co",
            "event_type": "hackathon",
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "prize_pool": parse_money(item.get("prize_pool") or item.get("prizes")),
            "tags": ["devfolio"],
            "status": "ANNOUNCED",
            "year": start.year if start else None,
            "raw_payload": item,
        }


class HackerEarthChallengesAdapter(SourceAdapter):
    """HackerEarth public hackathon/challenge listing (JSON-LD)."""

    domain = "hackathons"
    name = "hackerearth_challenges"
    display_name = "HackerEarth Challenges"
    tier = 2
    base_url = "https://www.hackerearth.com"
    service = "https://www.hackerearth.com/challenges/hackathon/"

    verification_note = "Public listing page structured data; parser unit-tested offline (EXTERNAL_DEPENDENCY for live HTTP)."

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        resp = await fetch(self.service, timeout=30, min_engine="httpx", max_engine="playwright")
        if resp.status != 200 or not resp.text:
            raise SourceTemporarilyUnavailable(f"hackerearth HTTP {resp.status}")
        return [
            RawDiscovery(source=self.name, payload=p, source_url=p.get("hackathon_url"),
                         extraction_method="json_ld")
            for p in self.parse_html(resp.text)
        ]

    @classmethod
    def parse_html(cls, html: str) -> list[dict]:
        out: list[dict] = []
        for block in extract_json_ld(html):
            for event in (block if isinstance(block, list) else [block]):
                if not isinstance(event, dict):
                    continue
                if str(event.get("@type", "")).lower() not in ("event", "webpage", "hackathonevent"):
                    continue
                name = clean_text(event.get("name"))
                if not name:
                    continue
                start = parse_datetime(event.get("startDate"))
                end = parse_datetime(event.get("endDate"))
                out.append({
                    "name": name,
                    "hackathon_url": clean_text(event.get("url")),
                    "source_url": clean_text(event.get("url")),
                    "source_platform": "hackerearth.com",
                    "organizer_name": clean_text(event.get("organizer")) if isinstance(event.get("organizer"), str) else None,
                    "event_type": "hackathon",
                    "event_start": start.isoformat() if start else None,
                    "event_end": end.isoformat() if end else None,
                    "tags": ["hackerearth"],
                    "status": "REGISTRATION_OPEN",
                    "year": start.year if start else None,
                    "raw_payload": event,
                })
        return out


# --------------------------------------------------------------------------- #
# Listing-page adapters (structured data first, labelled link discovery second)
# --------------------------------------------------------------------------- #

_SLUG_STOPWORDS = {"view", "details", "detail", "register", "apply", "more", "read", "click", "here", "event", "page"}


def name_from_url(url: str) -> Optional[str]:
    """Title-cased name derived from the source's OWN url slug.

    This is a derivation of the identifier the source published, never an invented
    name: the URL stays attached as provenance, the extraction method is recorded
    as ``link_discovery``, and the record is scored as low-completeness until a
    real listing confirms it.
    """
    from urllib.parse import urlparse

    path = urlparse(url or "").path.rstrip("/")
    if not path:
        return None
    slug = re.sub(r"\.(html?|php|aspx)$", "", path.split("/")[-1], flags=re.I)

    def keep(token: str) -> bool:
        if not token:
            return False
        if not token.isdigit():
            return True
        # Editions are commonly in the slug ("...-hackathon-2026"); a 4-digit year
        # is part of the source's own identifier, not an invented value.
        return len(token) == 4 and token.startswith(("19", "20"))

    words = [w for w in re.split(r"[-_]+|%20", slug) if keep(w)]
    if len([w for w in words if not w.isdigit()]) < 2:
        return None
    titled = " ".join(w if (w.isupper() and len(w) <= 5) else w.capitalize() for w in words)
    return clean_text(titled, 200) or None


class ListingPageAdapter(SourceAdapter):
    """A public listing page: JSON-LD events, plus (clearly labelled) link discovery.

    Subclasses only declare *where* the listing is and which URL shape identifies a
    hackathon detail page. The extraction rules live here so every platform gets
    the same honest treatment and the same provenance fields.
    """

    domain = "hackathons"
    listing_urls: tuple[str, ...] = ()
    platform: str = ""
    link_pattern: Optional[str] = None
    max_links: int = 40
    min_engine = "httpx"
    max_engine = "curl"

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch

        records: list[RawDiscovery] = []
        seen: set[str] = set()
        unreachable = 0
        for listing in self.listing_urls:
            try:
                resp = await fetch(listing, timeout=30, min_engine=self.min_engine,
                                   max_engine=self.max_engine)
            except Exception as e:  # noqa: BLE001 - try the next listing
                self._log.debug("%s listing failed %s: %s", self.name, listing, e)
                unreachable += 1
                continue
            if resp.status != 200 or not resp.text:
                unreachable += 1
                continue
            for parsed in self.parse_html(resp.text, listing):
                url = parsed.get("hackathon_url") or parsed.get("source_url")
                if url and url in seen:
                    continue
                if url:
                    seen.add(url)
                method = parsed.pop("_extraction", "json_ld")
                records.append(RawDiscovery(
                    source=self.name, payload=parsed, source_url=url, extraction_method=method,
                ))
        if not records and unreachable == len(self.listing_urls) and self.listing_urls:
            raise SourceTemporarilyUnavailable(f"{self.name}: all listings unreachable")
        return records

    @classmethod
    def parse_html(cls, html: str, listing_url: str) -> list[dict]:
        out: list[dict] = []
        for event in cls._json_ld_events(html):
            parsed = cls.parse_event(event, listing_url)
            if parsed:
                parsed["_extraction"] = "json_ld"
                out.append(parsed)
        if cls.link_pattern:
            for url, text in cls._candidate_links(html, listing_url)[: cls.max_links]:
                parsed = cls.parse_link(url, text, listing_url)
                if parsed:
                    parsed["_extraction"] = "link_discovery"
                    out.append(parsed)
        return out

    @classmethod
    def _json_ld_events(cls, html: str) -> list[dict]:
        events: list[dict] = []
        for block in extract_json_ld(html):
            for item in (block if isinstance(block, list) else [block]):
                if not isinstance(item, dict):
                    continue
                candidates = item.get("itemListElement") if isinstance(item.get("itemListElement"), list) else None
                if candidates:
                    for entry in candidates:
                        node = entry.get("item") if isinstance(entry, dict) and isinstance(entry.get("item"), dict) else entry
                        if isinstance(node, dict) and str(node.get("@type", "")).lower().endswith("event"):
                            events.append(node)
                    continue
                if str(item.get("@type", "")).lower() in ("event", "hackathonevent", "businessevent", "educationevent"):
                    events.append(item)
        return events

    @classmethod
    def _candidate_links(cls, html: str, listing_url: str) -> list[tuple[str, str]]:
        from urllib.parse import urljoin, urlparse

        host = (urlparse(listing_url).netloc or "").lower().replace("www.", "", 1)
        pattern = re.compile(cls.link_pattern) if cls.link_pattern else None
        if pattern is None:
            return []
        found: list[tuple[str, str]] = []
        seen: set[str] = set()
        for match in re.finditer(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]{0,160}?)</a>", html or "", re.I):
            href, text = match.group(1), clean_text(match.group(2), 160)
            if href.startswith(("mailto:", "tel:", "javascript:", "#")):
                continue
            absolute = urljoin(listing_url, href).split("#", 1)[0]
            parsed = urlparse(absolute)
            if parsed.scheme not in ("http", "https"):
                continue
            if (parsed.netloc or "").lower().replace("www.", "", 1) != host:
                continue
            if not pattern.search(parsed.path) or absolute in seen:
                continue
            seen.add(absolute)
            found.append((absolute, text))
        return found

    @classmethod
    def parse_event(cls, event: dict, listing_url: str) -> Optional[dict]:
        name = clean_text(event.get("name") or event.get("headline"))
        if not name:
            return None
        location = event.get("location") if isinstance(event.get("location"), dict) else {}
        address = location.get("address") if isinstance(location.get("address"), dict) else {}
        organizer = event.get("organizer")
        if isinstance(organizer, list):
            organizer = organizer[0] if organizer else None
        organizer = organizer if isinstance(organizer, dict) else {}
        offers = event.get("offers") if isinstance(event.get("offers"), dict) else {}
        start = parse_datetime(event.get("startDate"))
        end = parse_datetime(event.get("endDate"))
        mode_attr = str(event.get("eventAttendanceMode") or "").lower()
        mode = "online" if "online" in mode_attr else ("offline" if location else None)
        url = clean_text(event.get("url")) or listing_url
        return {
            "name": name,
            "hackathon_url": url,
            "source_url": url,
            "source_platform": cls.platform or listing_url,
            "organizer_name": clean_text(organizer.get("name")),
            "organizer_website": clean_text(organizer.get("url")),
            "organization_description": strip_html(event.get("description"), 800),
            "event_type": "hackathon",
            "mode": mode,
            "venue": clean_text(location.get("name") or address.get("streetAddress")),
            "city": clean_text(address.get("addressLocality")),
            "state": clean_text(address.get("addressRegion")),
            "country": clean_text(address.get("addressCountry")),
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "registration_deadline": parse_datetime(event.get("validThrough")).isoformat()
            if parse_datetime(event.get("validThrough")) else None,
            "prize_pool": parse_money(offers.get("price") if offers.get("price") else None),
            "open_to_public": True,
            "tags": [cls.platform or "listing"],
            "status": "ANNOUNCED",
            "year": start.year if start else None,
            "raw_payload": event,
        }

    @classmethod
    def parse_link(cls, url: str, link_text: str, listing_url: str) -> Optional[dict]:
        text = clean_text(link_text, 200)
        words = [w for w in text.split() if w]
        usable_text = text if len(words) >= 2 and text.lower() not in _SLUG_STOPWORDS else ""
        name = usable_text or name_from_url(url)
        if not name:
            return None
        return {
            "name": name,
            "hackathon_url": url,
            "source_url": url,
            "source_platform": cls.platform or listing_url,
            "event_type": "hackathon",
            "tags": [cls.platform or "listing", "link_discovery"],
            "status": "DISCOVERED",
            "raw_payload": {"url": url, "link_text": text or None, "listing_url": listing_url},
        }


class DoraHacksAdapter(ListingPageAdapter):
    """DoraHacks public hackathon listing."""

    name = "dorahacks"
    display_name = "DoraHacks"
    tier = 2
    base_url = "https://dorahacks.io"
    platform = "dorahacks.io"
    listing_urls = ("https://dorahacks.io/hackathon", "https://dorahacks.io/hackathons")
    link_pattern = r"/hackathon/[a-z0-9\-]{4,}"
    verification_note = "Public listing page; JSON-LD first, then labelled link discovery. Live HTTP not exercised in CI (EXTERNAL_DEPENDENCY)."


class HackIndiaAdapter(ListingPageAdapter):
    """HackIndia public hackathon listing."""

    name = "hackindia"
    display_name = "HackIndia"
    tier = 2
    base_url = "https://hackindia.org"
    platform = "hackindia.org"
    listing_urls = ("https://hackindia.org/", "https://hackindia.org/hackathons")
    link_pattern = r"/(?:hackathons?|events?)/[a-z0-9\-]{4,}"
    max_engine = "playwright"
    verification_note = "Public listing page; JSON-LD first, then labelled link discovery (EXTERNAL_DEPENDENCY for live HTTP)."


class ReskilllAdapter(ListingPageAdapter):
    """Reskilll public hackathon listing."""

    name = "reskilll"
    display_name = "Reskilll"
    tier = 2
    base_url = "https://reskilll.com"
    platform = "reskilll.com"
    listing_urls = ("https://reskilll.com/hackathons", "https://reskilll.com/events")
    link_pattern = r"/(?:hackathon|event)/[a-z0-9\-]{4,}"
    verification_note = "Public listing page; JSON-LD first, then labelled link discovery (EXTERNAL_DEPENDENCY for live HTTP)."


class EventopiaAdapter(ListingPageAdapter):
    """Eventopia public event listing (hackathon filter applied on site)."""

    name = "eventopia"
    display_name = "Eventopia"
    tier = 3
    base_url = "https://eventopia.in"
    platform = "eventopia.in"
    listing_urls = ("https://eventopia.in/hackathons", "https://eventopia.in/events")
    link_pattern = r"/events?/[a-z0-9\-]{4,}"
    verification_note = "Public event calendar; only hackathon-shaped URLs are kept (EXTERNAL_DEPENDENCY for live HTTP)."


class HackathonSpaceAdapter(ListingPageAdapter):
    """hackathons.space public aggregator listing."""

    name = "hackathons_space"
    display_name = "hackathons.space"
    tier = 3
    base_url = "https://hackathons.space"
    platform = "hackathons.space"
    listing_urls = ("https://hackathons.space/",)
    link_pattern = r"/(?:hackathon|event)s?/[a-z0-9\-]{4,}"
    verification_note = "Community aggregator; JSON-LD first, then labelled link discovery (EXTERNAL_DEPENDENCY for live HTTP)."


class HackathonFinderAdapter(ListingPageAdapter):
    """Hackathon Finder (shetty.me) public listing."""

    name = "hackathon_finder"
    display_name = "Hackathon Finder"
    tier = 3
    base_url = "https://hackathon-finder.shetty.me"
    platform = "hackathon-finder.shetty.me"
    listing_urls = ("https://hackathon-finder.shetty.me/",)
    link_pattern = r"/(?:hackathon|event)s?/[a-z0-9\-]{4,}"
    max_engine = "playwright"
    verification_note = "Community aggregator; JSON-LD first, then labelled link discovery (EXTERNAL_DEPENDENCY for live HTTP)."


class SihPortalAdapter(ListingPageAdapter):
    """Smart India Hackathon official portal (government event pages)."""

    name = "sih_portal"
    display_name = "Smart India Hackathon (official)"
    tier = 1
    base_url = "https://sih.gov.in"
    platform = "sih.gov.in"
    listing_urls = ("https://sih.gov.in/", "https://sih.gov.in/hackathon")
    link_pattern = r"/(?:sih|hackathon)[a-z0-9/\-]*"
    verification_note = "Government portal; public pages only, JSON-LD first (EXTERNAL_DEPENDENCY for live HTTP)."


class RssHackathonAdapter(ListingPageAdapter):
    """Public RSS/Atom feeds of hackathon calendars and developer communities.

    Feeds are configuration, not code: set ``HACKATHON_RSS_FEEDS`` to a
    comma-separated list of public feed URLs (community calendars, GDG chapters,
    organizer blogs). With no feeds configured the adapter is skipped rather than
    guessing endpoints.
    """

    name = "hackathon_rss"
    display_name = "Hackathon RSS feeds"
    tier = 3
    base_url = None
    platform = "rss"
    enabled_by_default = bool(os.environ.get("HACKATHON_RSS_FEEDS", "").strip())
    min_engine = "httpx"
    max_engine = "httpx"
    verification_note = "Configured public feeds only; disabled until HACKATHON_RSS_FEEDS is set."

    @property
    def listing_urls(self) -> tuple[str, ...]:  # type: ignore[override]
        raw = os.environ.get("HACKATHON_RSS_FEEDS", "")
        return tuple(u.strip() for u in raw.split(",") if u.strip())

    @classmethod
    def parse_html(cls, html: str, listing_url: str) -> list[dict]:
        """RSS/Atom items: only what the feed itself publishes."""
        out: list[dict] = []
        for match in re.finditer(r"<item\b[\s\S]*?</item>|<entry\b[\s\S]*?</entry>", html or "", re.I):
            block = match.group(0)
            title = _tag_text(block, "title")
            link = _tag_text(block, "link") or _attr_text(block, "link", "href")
            if not title or not link:
                continue
            published = _tag_text(block, "pubdate") or _tag_text(block, "published") or _tag_text(block, "updated")
            start = parse_datetime(published)
            out.append({
                "name": clean_text(strip_html(title), 200),
                "hackathon_url": clean_text(link),
                "source_url": clean_text(link),
                "source_platform": listing_url,
                "organization_description": strip_html(_tag_text(block, "description") or _tag_text(block, "summary"), 800),
                "event_type": "hackathon",
                "registration_start": start.isoformat() if start else None,
                "tags": ["rss"],
                "status": "ANNOUNCED",
                "year": start.year if start else None,
                "raw_payload": {"title": title, "link": link, "published": published},
                "_extraction": "rss",
            })
        return out


class CuratedListAdapter(ListingPageAdapter):
    """Public curated hackathon lists (raw JSON/CSV on GitHub or similar).

    Configured via ``HACKATHON_LIST_FEEDS`` (comma-separated raw URLs). Each entry
    must be JSON (a list or an object with a list under name/url/date keys) or CSV
    with name + url columns; anything else is reported and skipped.
    """

    name = "hackathon_curated_lists"
    display_name = "Curated hackathon lists"
    tier = 3
    base_url = None
    platform = "curated_list"
    enabled_by_default = bool(os.environ.get("HACKATHON_LIST_FEEDS", "").strip())
    min_engine = "httpx"
    max_engine = "httpx"
    verification_note = "Configured public datasets only; disabled until HACKATHON_LIST_FEEDS is set."

    @property
    def listing_urls(self) -> tuple[str, ...]:  # type: ignore[override]
        raw = os.environ.get("HACKATHON_LIST_FEEDS", "")
        return tuple(u.strip() for u in raw.split(",") if u.strip())

    @classmethod
    def parse_html(cls, html: str, listing_url: str) -> list[dict]:
        import csv
        import io

        text = (html or "").strip()
        rows: list[dict] = []
        if text.startswith(("[", "{")):
            try:
                data = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                return []
            items = find_key_list(data, ("hackathons", "events", "items", "data", "results")) or (
                [i for i in data if isinstance(i, dict)] if isinstance(data, list) else []
            )
            rows = items
        else:
            try:
                rows = list(csv.DictReader(io.StringIO(text)))
            except Exception:  # noqa: BLE001 - a malformed dataset is just skipped
                return []
        out: list[dict] = []
        for item in rows:
            lower = {str(k).strip().lower(): v for k, v in item.items()}
            name = clean_text(lower.get("name") or lower.get("title") or lower.get("hackathon") or "")
            url = clean_text(lower.get("url") or lower.get("link") or lower.get("hackathon_url") or "")
            if not name and url:
                name = name_from_url(url)
            if not name:
                continue
            start = parse_datetime(
                lower.get("start") or lower.get("start_date") or lower.get("starts_at")
                or lower.get("date") or lower.get("event_start")
            )
            out.append({
                "name": name,
                "hackathon_url": url or None,
                "source_url": url or listing_url,
                "source_platform": listing_url,
                "organizer_name": clean_text(lower.get("organizer") or lower.get("organisation") or lower.get("host") or ""),
                "event_type": "hackathon",
                "city": clean_text(lower.get("city") or "") or None,
                "state": clean_text(lower.get("state") or "") or None,
                "country": clean_text(lower.get("country") or "") or None,
                "event_start": start.isoformat() if start else None,
                "event_end": (end.isoformat() if (end := parse_datetime(lower.get("end") or lower.get("end_date") or lower.get("ends_at"))) else None),
                "prize_pool": parse_money(lower.get("prize") or lower.get("prize_pool")),
                "tags": ["curated_list"],
                "status": "DISCOVERED",
                "year": start.year if start else None,
                "raw_payload": item,
                "_extraction": "dataset",
            })
        return out


def _tag_text(block: str, tag: str) -> str:
    m = re.search(rf"<{tag}\b[^>]*>(.*?)</{tag}>", block, re.I | re.S)
    return clean_text(m.group(1), 400) if m else ""


def _attr_text(block: str, tag: str, attr: str) -> str:
    m = re.search(rf"<{tag}\b[^>]*{attr}=[\"']([^\"']+)[\"']", block, re.I)
    return clean_text(m.group(1), 400) if m else ""


class GdgEventsAdapter(SourceAdapter):
    """Google Developer Groups (GDG) public events directory.

    GDG chapters publish their events (dev fests, study jams, hackathons) as
    JSON on the public events service used by the gdg.community.dev site. Many
    of those events are hackathon-shaped; the filter keeps what declares itself
    as one instead of ingesting every meetup. Configurable via
    ``GDG_EVENTS_URL`` when Google moves the endpoint.
    """

    domain = "hackathons"
    name = "gdg_events"
    display_name = "Google Developer Groups events"
    tier = 2
    base_url = "https://gdg.community.dev"
    service = "https://api.gdg.community.dev/api/v3/events"

    verification_note = (
        "Public GDG events JSON; parser unit-tested offline. Live HTTP not "
        "exercised in CI (EXTERNAL_DEPENDENCY)."
    )

    HACK_HINTS = ("hackathon", "hack", "devfest", "dev fest", "build", "code")

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        url = os.environ.get("GDG_EVENTS_URL", "").strip() or self.service
        resp = await fetch(url, timeout=30, headers={"Accept": "application/json"},
                           min_engine="httpx", max_engine="curl")
        if resp.status != 200:
            raise SourceTemporarilyUnavailable(f"gdg HTTP {resp.status}")
        try:
            data = json.loads(resp.text)
        except (json.JSONDecodeError, TypeError):
            raise SourceTemporarilyUnavailable("gdg: non-JSON response") from None
        items = find_key_list(data, ("results", "items", "events", "data"))
        records: list[RawDiscovery] = []
        for item in items:
            parsed = self.parse_item(item)
            if parsed:
                records.append(RawDiscovery(
                    source=self.name,
                    payload=parsed,
                    source_url=parsed.get("hackathon_url"),
                    extraction_method="api_json",
                ))
        return records

    @classmethod
    def parse_item(cls, item: dict) -> Optional[dict]:
        name = clean_text(item.get("title") or item.get("name"))
        if not name:
            return None
        lowered = name.lower()
        if not any(hint in lowered for hint in cls.HACK_HINTS):
            return None
        url = clean_text(item.get("event_url") or item.get("url"))
        start = parse_datetime(item.get("start_date") or item.get("startDate"))
        end = parse_datetime(item.get("end_date") or item.get("endDate"))
        city = clean_text(item.get("city"))
        state = clean_text(item.get("state") or item.get("area"))
        country = clean_text(item.get("country"))
        mode = "offline" if city else None
        organizer = clean_text(item.get("chapter") or item.get("organizer"))
        if isinstance(item.get("chapter"), dict):
            organizer = clean_text(item["chapter"].get("name"))
        return {
            "name": name,
            "hackathon_url": url,
            "source_url": url,
            "source_platform": "gdg.community.dev",
            "organizer_name": organizer or "Google Developer Groups",
            "organizer_type": "community",
            "event_type": "hackathon",
            "mode": mode,
            "city": city,
            "state": state,
            "country": country,
            "event_start": start.isoformat() if start else None,
            "event_end": end.isoformat() if end else None,
            "open_to_public": True,
            "tags": ["gdg", "community"],
            "status": "ANNOUNCED",
            "year": start.year if start else None,
            "raw_payload": item,
        }


class CompanyChallengesAdapter(ListingPageAdapter):
    """Corporate hackathon/challenge listing pages (GRiD, CodeVita, ML, etc.).

    Companies publish their recurring flagship challenges on public career or
    community pages. One adapter covers every configured company listing:
    entries are ``name|url`` pairs in ``COMPANY_CHALLENGE_URLS`` (comma
    separated) so adding Flipkart GRiD or TCS CodeVita is configuration, not
    code. Extraction is inherited from ``ListingPageAdapter`` (JSON-LD events
    plus same-site link discovery) so company pages get exactly the treatment
    the event platforms get.
    """

    name = "company_challenges"
    display_name = "Company challenge pages"
    tier = 2
    base_url = None
    platform = "company_challenge"
    enabled_by_default = bool(os.environ.get("COMPANY_CHALLENGE_URLS", "").strip())
    verification_note = (
        "Configured public company listing pages only; disabled until "
        "COMPANY_CHALLENGE_URLS is set (name|url pairs)."
    )

    @staticmethod
    def parse_config(raw: str) -> list[tuple[str, str]]:
        entries: list[tuple[str, str]] = []
        for chunk in (raw or "").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            if "|" in chunk:
                company, url = chunk.split("|", 1)
                if url.startswith("http"):
                    entries.append((company.strip(), url.strip()))
            elif chunk.startswith("http"):
                entries.append(("", chunk))
        return entries

    async def discover(self) -> list[RawDiscovery]:
        from ...utils.http_client import fetch
        entries = self.parse_config(os.environ.get("COMPANY_CHALLENGE_URLS", ""))
        if not entries:
            raise SourceTemporarilyUnavailable("COMPANY_CHALLENGE_URLS not configured")
        records: list[RawDiscovery] = []
        failures = 0
        for company, url in entries:
            try:
                resp = await fetch(url, timeout=30, min_engine="httpx", max_engine="playwright")
            except Exception:  # noqa: BLE001 - the next listing is independent
                failures += 1
                continue
            if resp.status != 200 or not resp.text:
                failures += 1
                continue
            for parsed in ListingPageAdapter.parse_html(resp.text, url):
                if not parsed.get("name"):
                    continue
                parsed["organizer_name"] = parsed.get("organizer_name") or company or None
                parsed["organizer_type"] = parsed.get("organizer_type") or "company"
                parsed.setdefault("tags", [])
                if "company_challenge" not in parsed["tags"]:
                    parsed["tags"].append("company_challenge")
                records.append(RawDiscovery(source=self.name, payload=parsed,
                                            source_url=parsed.get("hackathon_url"),
                                            extraction_method=parsed.pop("_extraction", "listing")))
        if not records and failures == len(entries):
            raise SourceTemporarilyUnavailable(f"all {failures} company listings unavailable")
        return records


class PausedSourceAdapter(ListingPageAdapter):
    """Base for public sources that need a terms/reliability review first.

    These adapters exist, are unit-tested offline, and stay disabled until an
    operator enables them after reviewing the site's terms. That is the honest
    position: the code works, the permission decision is a human one.
    """

    enabled_by_default = False
    verification_note = "Disabled pending a source terms review; parser unit-tested offline."


class CodeChefContestsAdapter(PausedSourceAdapter):
    """CodeChef contest listing (challenge-style events, not classic hackathons)."""

    name = "codechef_contests"
    display_name = "CodeChef contests"
    tier = 3
    base_url = "https://www.codechef.com"
    platform = "codechef.com"
    listing_urls = ("https://www.codechef.com/contests",)
    link_pattern = None
    max_engine = "playwright"
    verification_note = (
        "Contest listing has no stable public structured feed; enable only after a "
        "source review. Disabled by default."
    )


class InsiderEventsAdapter(PausedSourceAdapter):
    """insider.in public event listings (hackathon-shaped URLs only)."""

    name = "insider_events"
    display_name = "Insider events"
    tier = 3
    base_url = "https://insider.in"
    platform = "insider.in"
    listing_urls = ("https://insider.in/hackathons",)
    link_pattern = r"/[a-z0-9\-]{6,}"
    max_engine = "playwright"


HACKATHON_ADAPTERS: tuple[type[SourceAdapter], ...] = (
    DevpostAdapter,
    UnstopHackathonAdapter,
    MlhAdapter,
    DevfolioAdapter,
    HackerEarthChallengesAdapter,
    SihPortalAdapter,
    HackIndiaAdapter,
    ReskilllAdapter,
    DoraHacksAdapter,
    EventopiaAdapter,
    HackathonSpaceAdapter,
    HackathonFinderAdapter,
    RssHackathonAdapter,
    CuratedListAdapter,
    CodeChefContestsAdapter,
    InsiderEventsAdapter,
    GdgEventsAdapter,
    CompanyChallengesAdapter,
)
