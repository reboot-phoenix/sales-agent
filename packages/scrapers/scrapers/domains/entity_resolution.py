"""Entity resolution + deduplication signals (pure functions).

The platform must never create a second canonical row for the same real-world
hackathon, college or contact. Because sources spell things differently, a single
exact key is not enough, so matching combines several independent signals and
weights them. All of it is deterministic and unit-testable; the DB-facing
resolver lives in each domain's normalizer and calls these helpers.

Signals used (in rough strength order):
  * strong identifiers: AISHE code, official website domain, event URL
  * normalized name/year, organizer name
  * geographic anchors (state, city)
  * fuzzy name similarity (difflib, stdlib — no new dependency)
"""

from __future__ import annotations

import hashlib
from difflib import SequenceMatcher
from typing import Any, Optional

from .normalize import extract_domain, normalize_name_key, slugify

FUZZY_MATCH_THRESHOLD = 0.86
FUZZY_REVIEW_THRESHOLD = 0.72


def _hash(*parts: Any) -> str:
    joined = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def fingerprint_hackathon(name: Any, organizer: Any = None, url: Any = None) -> str:
    """Canonical hackathon key.

    Name + organizer is the primary identity. The URL is included only when it
    carries a distinct host, so two source pages for one event resolve to one row
    while two unrelated events that share a generic title do not.
    """
    domain = extract_domain(url) or ""
    return _hash(normalize_name_key(name), normalize_name_key(organizer), domain)


def fingerprint_college(
    name: Any,
    state: Any = None,
    aishe_code: Any = None,
    website: Any = None,
) -> str:
    """Canonical college key.

    AISHE code wins outright when present (it is the government's own identity
    key). Otherwise the key is name + state: many unrelated \"Government
    Engineering College\" exist across India, so state must be part of the
    identity or they would collapse into one row.
    """
    if aishe_code and normalize_name_key(aishe_code):
        return _hash("aishe", normalize_name_key(aishe_code))
    return _hash(
        normalize_name_key(name),
        normalize_name_key(state),
        extract_domain(website) or "",
    )


def occurrence_key(hackathon_id: Any, year: Any) -> str:
    return _hash("occurrence", str(hackathon_id), str(year))


def slug_for(name: Any, suffix: Any = None) -> str:
    base = slugify(name)[:100] or "unknown"
    if suffix:
        return f"{base}-{slugify(suffix)[:20]}"
    return base


def name_similarity(a: Any, b: Any) -> float:
    """0..1 similarity of two normalized names."""
    ka, kb = normalize_name_key(a), normalize_name_key(b)
    if not ka or not kb:
        return 0.0
    if ka == kb:
        return 1.0
    return SequenceMatcher(None, ka, kb).ratio()


def same_hackathon(a: dict[str, Any], b: dict[str, Any]) -> tuple[bool, float, list[str]]:
    """Decide whether two hackathon dicts are the same canonical event.

    Returns (is_same, confidence 0..1, matched_signals). Exact name+year is a
    definitive match; otherwise the score accumulates independent signals and
    must clear FUZZY_MATCH_THRESHOLD.
    """
    signals: list[str] = []
    # 1. Same event URL (host+path) is decisive.
    ua, ub = _full_url_key(a.get("hackathon_url")), _full_url_key(b.get("hackathon_url"))
    if ua and ub and ua == ub:
        return True, 1.0, ["hackathon_url"]
    # 2. Same name + same year.
    if normalize_name_key(a.get("name")) == normalize_name_key(b.get("name")):
        ya, yb = _year_of(a), _year_of(b)
        if ya and yb and ya == yb:
            return True, 0.98, ["name", "year"]
    score = 0.0
    sim = name_similarity(a.get("name"), b.get("name"))
    if sim >= FUZZY_MATCH_THRESHOLD:
        score += 0.5 * sim
        signals.append(f"name_similarity:{sim:.2f}")
    org_sim = name_similarity(a.get("organizer_name"), b.get("organizer_name"))
    if org_sim >= FUZZY_MATCH_THRESHOLD:
        score += 0.2 * org_sim
        signals.append(f"organizer_similarity:{org_sim:.2f}")
    if _year_of(a) and _year_of(a) == _year_of(b):
        score += 0.15
        signals.append("year")
    if normalize_name_key(a.get("city")) and normalize_name_key(a.get("city")) == normalize_name_key(b.get("city")):
        score += 0.1
        signals.append("city")
    if extract_domain(a.get("organizer_website")) and extract_domain(a.get("organizer_website")) == extract_domain(b.get("organizer_website")):
        score += 0.05
        signals.append("organizer_domain")
    return score >= FUZZY_MATCH_THRESHOLD, round(min(score, 1.0), 3), signals


def same_college(a: dict[str, Any], b: dict[str, Any]) -> tuple[bool, float, list[str]]:
    """Decide whether two college dicts are the same institution."""
    signals: list[str] = []
    ka, kb = normalize_name_key(a.get("aishe_code")), normalize_name_key(b.get("aishe_code"))
    if ka and kb and ka == kb:
        return True, 1.0, ["aishe_code"]
    da, db = extract_domain(a.get("website_url")), extract_domain(b.get("website_url"))
    if da and db and da == db:
        sa, sb = normalize_name_key(a.get("state")), normalize_name_key(b.get("state"))
        if not sa or not sb or sa == sb:
            return True, 0.97, ["website_domain", "state"]
    sim = name_similarity(a.get("name"), b.get("name"))
    sa, sb = normalize_name_key(a.get("state")), normalize_name_key(b.get("state"))
    same_state = bool(sa and sb and sa == sb)
    score = 0.0
    if sim >= FUZZY_MATCH_THRESHOLD:
        score += 0.55 * sim
        signals.append(f"name_similarity:{sim:.2f}")
        if same_state:
            score += 0.2
            signals.append("state")
    if normalize_name_key(a.get("city")) and normalize_name_key(a.get("city")) == normalize_name_key(b.get("city")):
        score += 0.15
        signals.append("city")
    if normalize_name_key(a.get("district")) and normalize_name_key(a.get("district")) == normalize_name_key(b.get("district")):
        score += 0.1
        signals.append("district")
    return score >= FUZZY_MATCH_THRESHOLD, round(min(score, 1.0), 3), signals


def contact_identity(full_name: Any, email: Any = None, phone: Any = None, linkedin: Any = None) -> Optional[str]:
    """Stable identity for a person contact, or None when nothing identifies them.

    Email/phone/LinkedIn win (they are unique to a person). A name alone is NOT
    an identity: two people called 'R Sharma' at one college must not be merged,
    and no contact is ever created from a name with no locator at all.
    """
    if email and "@" in str(email):
        return _hash("email", str(email).strip().lower())
    if phone:
        digits = "".join(ch for ch in str(phone) if ch.isdigit())
        if len(digits) >= 8:
            return _hash("phone", digits[-10:])
    if linkedin:
        key = normalize_name_key(str(linkedin).rstrip("/").rsplit("/", 1)[-1])
        if key:
            return _hash("linkedin", key)
    return None


def _full_url_key(url: Any) -> str:
    text = ("" if url is None else str(url)).strip().lower().rstrip("/")
    if not text:
        return ""
    if "://" in text:
        text = text.split("://", 1)[1]
    return text


def _year_of(record: dict[str, Any]) -> Optional[int]:
    for key in ("year", "event_start", "event_end", "registration_start", "predicted_occurrence"):
        value = record.get(key)
        if value in (None, ""):
            continue
        text = str(value)
        import re
        m = re.match(r"(\d{4})", text)
        if m:
            return int(m.group(1))
    return None
