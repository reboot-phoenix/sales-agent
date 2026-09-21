"""Shared normalization primitives for the intelligence domains.

Pure functions only — no I/O — so every rule here is unit-testable without a
network or database. The guiding rule of the platform is that a missing value
must stay missing: helpers return ``None``/``""`` rather than guessing.
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import date, datetime, timezone
from typing import Any, Iterable, Optional

_WS = re.compile(r"\s+")


def clean_text(value: Any, limit: int = 4000) -> str:
    """Trim, collapse whitespace, drop control chars. Never fabricates."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        parts = [clean_text(v, limit) for v in value]
        return ", ".join(p for p in parts if p)[:limit]
    if isinstance(value, dict):
        for key in ("name", "title", "label", "text", "value"):
            if value.get(key):
                return clean_text(value[key], limit)
        return ""
    text = _WS.sub(" ", str(value)).strip()
    text = "".join(ch for ch in text if ch == " " or unicodedata.category(ch)[0] != "C")
    return text[:limit]


def strip_html(value: Any, limit: int = 4000) -> str:
    """Remove tags/entities from a snippet. Descriptions arrive as HTML."""
    text = "" if value is None else str(value)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&#39;", "'").replace("&quot;", '"'))
    return clean_text(text, limit)


def slugify(value: Any, max_len: int = 120) -> str:
    """URL-safe slug used as a stable canonical key."""
    text = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len]


def normalize_name_key(value: Any) -> str:
    """Alphanumeric-only lowercase key for entity matching.

    'IIT (BHU) Varanasi' -> 'iitbhuvaranasi'; used for exact-key dedup, never
    display. Token order and the full token text are both preserved so distinct
    institutions do not collide on an initials-only key.
    """
    text = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", text.lower())


def parse_rfc822_datetime(value: Any) -> Optional[datetime]:
    """Parse an RSS/Atom date (RFC 822/2822) into an aware UTC datetime.

    Feed dates look like 'Mon, 05 Jan 2026 10:00:00 GMT', which the ISO/worded
    parser cannot read. Feeds are a real discovery source, so this is handled
    explicitly rather than silently dropping the date.
    """
    text = clean_text(value)
    if not text:
        return None
    from email.utils import parsedate_to_datetime

    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_bool(value: Any) -> Optional[bool]:
    """Tri-state: True/False, or None when the source did not say.

    Critically, absent is None — never False — so 'open to public' does not
    silently become 'no' just because a field was missing.
    """
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    text = str(value).strip().lower()
    if text in ("true", "yes", "y", "1", "open", "allowed", "available"):
        return True
    if text in ("false", "no", "n", "0", "closed", "not allowed", "unavailable", "none"):
        return False
    return None


_MONEY_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(lakh|lakhs|lpa|lac|lacs|crore|cr|k|thousand|million|mn|usd|inr|₹|\$|€|£)?", re.I)
_UNIT_MULT = {
    "lakh": 100_000.0, "lakhs": 100_000.0, "lpa": 100_000.0, "lac": 100_000.0, "lacs": 100_000.0,
    "crore": 10_000_000.0, "cr": 10_000_000.0, "million": 1_000_000.0, "mn": 1_000_000.0,
    "k": 1_000.0, "thousand": 1_000.0,
}


def parse_money(value: Any, *, text: Optional[str] = None) -> Optional[float]:
    """Parse a prize pool / package into a plain number.

    Handles '₹1,00,000', 'INR 5 Lakh', '10 lakhs', '$10,000', '1 crore'. A bare
    number with no unit is returned as-is (never scaled by guesswork). Returns
    None when nothing numeric is present.
    """
    raw = clean_text(value) if value not in (None, "") else clean_text(text or "")
    if not raw:
        return None
    raw = raw.replace(",", "")
    m = _MONEY_RE.search(raw)
    if not m:
        return None
    try:
        amount = float(m.group(1))
    except (TypeError, ValueError):
        return None
    unit = (m.group(2) or "").lower()
    if unit:
        amount *= _UNIT_MULT.get(unit, 1.0)
    return amount if amount > 0 else None


_DATE_FORMATS = (
    "%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y",
    "%B %d, %Y", "%b %d, %Y", "%d %B %Y", "%d %b %Y",
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S",
    "%B %Y", "%b %Y",
)


def parse_datetime(value: Any, *, assume_end_of_range: bool = False) -> Optional[datetime]:
    """Parse a date/datetime into an aware UTC datetime, or None.

    A month-only value ('March 2026') resolves to the first (or last) day of that
    month — both are honest declarations of a month-granularity fact, and the
    caller stores the granularity via provenance, not a fake exact day.
    """
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    # Epoch seconds/millis
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        num = float(value)
        if num > 1e11:
            num /= 1000.0
        try:
            return datetime.fromtimestamp(num, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    text = clean_text(value)
    if not text:
        return None
    iso = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    # RSS/Atom feeds publish RFC 822 dates; keep them instead of dropping the date.
    if re.search(r"[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}", text):
        rfc = parse_rfc822_datetime(text)
        if rfc:
            return rfc
    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if fmt in ("%B %Y", "%b %Y"):
            if assume_end_of_range:
                if dt.month == 12:
                    return dt.replace(day=31)
                nxt = dt.replace(month=dt.month + 1, day=1)
                return nxt.replace(day=1)
            return dt.replace(day=1)
        return dt.replace(tzinfo=timezone.utc)
    return None


def parse_date(value: Any) -> Optional[date]:
    dt = parse_datetime(value)
    return dt.date() if dt else None


def parse_date_range(value: Any) -> tuple[Optional[datetime], Optional[datetime]]:
    """Split a source's free-text period into (start, end).

    Real boards emit many shapes: "Jan 01 - Jan 01, 2026", "March 5-7, 2026",
    "2026-03-05 to 2026-03-07", "5 – 7 Mar 2026". A missing year on the left side
    is inherited from the right side, which is how these strings are written.
    Returns (None, None) when nothing parses — never invents dates.
    """
    text = clean_text(value)
    if not text:
        return None, None
    if re.search(r"\b(ongoing|rolling|tba|to be announced|n/?a)\b", text, re.I):
        return None, None
    # Normalize separators to a single split point, longest first.
    for sep in ("→", "–", "—", " to ", " until ", " - ", "-"):
        if sep in text:
            parts = text.split(sep, 1)
            break
    else:
        parts = [text]
    left = clean_text(parts[0])
    right = clean_text(parts[1]) if len(parts) > 1 else ""
    start = parse_datetime(left)
    end = parse_datetime(right, assume_end_of_range=True)
    # Inherit the year for a bare left side ("Jan 01" + "Jan 05, 2026").
    if start is None and right and left:
        ym = re.search(r"(\d{4})", right)
        if ym and re.match(r"^[A-Za-z]{3,9}\s+\d{1,2}$", left):
            start = parse_datetime(f"{left}, {ym.group(1)}")
    if start is None and not right:
        start = parse_datetime(left, assume_end_of_range=True)
    if start and end and end < start:
        start, end = end, start
    return start, end


def as_list(value: Any) -> list[str]:
    """Coerce a field to a de-duplicated list of non-empty strings."""
    out: list[str] = []
    if value is None or value == "":
        return out
    items: Iterable[Any]
    if isinstance(value, str):
        # Comma/semicolon/pipe separated lists are the common scrape shape.
        items = re.split(r"[,;|]", value) if re.search(r"[,;|]", value) else [value]
    elif isinstance(value, (list, tuple, set)):
        items = value
    else:
        items = [value]
    for item in items:
        text = clean_text(item, 200)
        if text and text not in out:
            out.append(text)
    return out


def extract_domain(url: Any) -> Optional[str]:
    """Registrable-ish hostname from a URL. Returns None for junk."""
    text = clean_text(url, 500)
    if not text:
        return None
    if "://" not in text:
        text = "https://" + text.lstrip("/")
    try:
        from urllib.parse import urlparse
        host = (urlparse(text).hostname or "").lower().rstrip(".")
    except (ValueError, TypeError):
        return None
    if not host or "." not in host:
        return None
    return host[4:] if host.startswith("www.") else host


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, default=str)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
