"""Data quality, freshness, verification and outreach readiness.

All pure functions so the scores are reproducible and testable. Rules differ per
domain on purpose: a two-week-old job posting is aging, a two-week-old college
record is brand new, and a hackathon is judged by where it sits in its own
registration/event window. Applying one TTL everywhere would be wrong.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

# Weighted important fields. Weights reflect outreach value, not trivia: a
# verified TPO email matters far more than a college's PIN code.
HACKATHON_FIELDS: tuple[tuple[str, int], ...] = (
    ("name", 5), ("hackathon_url", 5), ("organizer_name", 4),
    ("event_start", 3), ("registration_deadline", 3), ("mode", 2),
    ("city", 1), ("state", 2), ("prize_pool", 2), ("technology", 2),
    ("domain", 1), ("eligibility", 2),
    ("contact_email", 5), ("contact_name", 5), ("contact_linkedin", 4),
    ("organizer_email", 4), ("contact_phone", 3),
)

COLLEGE_FIELDS: tuple[tuple[str, int], ...] = (
    ("name", 5), ("state", 4), ("city", 3), ("district", 3),
    ("website_url", 4), ("official_email", 4), ("phone", 3),
    ("university_affiliation", 2), ("institution_type", 2), ("ownership", 2),
    ("aishe_code", 3), ("accreditation", 2), ("placement_contact", 3),
    ("tpo_name", 5), ("tpo_email", 5), ("tpo_phone", 4),
    ("principal_name", 4), ("director_name", 3), ("dean_name", 3),
)

_DOMAIN_FIELDS = {
    "hackathons": HACKATHON_FIELDS,
    "colleges": COLLEGE_FIELDS,
}


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    return True


def completeness_score(domain: str, record: dict[str, Any]) -> tuple[int, list[str]]:
    """0..100 completeness plus the list of missing important fields."""
    fields = _DOMAIN_FIELDS.get(domain, ())
    if not fields:
        return 0, []
    total = sum(w for _, w in fields)
    earned = 0
    missing: list[str] = []
    for field, weight in fields:
        if _present(record.get(field)):
            earned += weight
        else:
            missing.append(field)
    return int(round(earned / total * 100)), missing


# Domain-specific freshness windows in days: (fresh, recent, aging) — beyond the
# last bound is 'stale'.
_WINDOWS = {
    "jobs": (1, 7, 30),
    "hackathons": (14, 45, 120),
    "colleges": (90, 180, 365),
}


def freshness_category(domain: str, record: dict[str, Any], now: Optional[datetime] = None) -> str:
    """FRESH / RECENT / AGING / STALE / UNKNOWN drawn from the most recent
    timestamp the record actually carries. No timestamp -> UNKNOWN, never guessed.
    """
    ref = now or datetime.now(timezone.utc)
    stamp = _latest_stamp(record)
    if stamp is None:
        return "unknown"
    age_days = (ref - stamp).total_seconds() / 86400.0
    if age_days < 0:
        # A future event/registration is as current as it gets.
        return "fresh"
    fresh, recent, aging = _WINDOWS.get(domain, (7, 30, 120))
    if age_days <= fresh:
        return "fresh"
    if age_days <= recent:
        return "recent"
    if age_days <= aging:
        return "aging"
    return "stale"


def freshness_score(domain: str, record: dict[str, Any], now: Optional[datetime] = None) -> int:
    return {"fresh": 100, "recent": 75, "aging": 45, "stale": 15, "unknown": 0}[
        freshness_category(domain, record, now)
    ]


def _latest_stamp(record: dict[str, Any]) -> Optional[datetime]:
    from .normalize import parse_datetime

    best: Optional[datetime] = None
    for key in ("last_verified_at", "last_seen_at", "updated_at", "event_start",
                "registration_deadline", "first_seen_at", "created_at"):
        dt = parse_datetime(record.get(key))
        if dt and (best is None or dt > best):
            best = dt
    return best


def verification_score(record: dict[str, Any]) -> int:
    """0..100 from the explicit verification state, not from hopeful guessing."""
    status = str(record.get("verification_status") or "").lower()
    grade = str(record.get("verification_grade") or "").upper()
    base = {
        "verified": 100, "cross_verified": 100, "partially_verified": 70,
        "unverified": 20, "not_verified": 20, "failed": 0,
    }.get(status, 10)
    if grade:
        base = min(100, base + {"A": 5, "B": 0, "C": -10}.get(grade[0], 0))
    sources = int(record.get("source_count") or 0)
    if sources >= 3:
        base = min(100, base + 10)
    elif sources >= 2:
        base = min(100, base + 5)
    return max(0, min(100, base))


def confidence_score(domain: str, record: dict[str, Any], *, contact_verified: bool = False) -> int:
    """Composite confidence: verification + source breadth + completeness.

    Deliberately conservative — an unverified single-source row scores low even if
    every field happens to be filled.
    """
    completeness, _ = completeness_score(domain, record)
    verification = verification_score(record)
    source_count = int(record.get("source_count") or 0)
    source_breadth = min(100, source_count * 40)
    score = 0.4 * verification + 0.3 * source_breadth + 0.3 * completeness
    if contact_verified:
        score = min(100, score + 10)
    return int(round(score))


def outreach_readiness(
    domain: str,
    record: dict[str, Any],
    *,
    has_contact_locator: bool,
    contact_locator_count: int = 0,
) -> str:
    """OUTREACH_READY / PARTIALLY_ENRICHED / NEEDS_ENRICHMENT / INSUFFICIENT_DATA.

    A record with a URL alone is never outreach-ready. Ready requires at least one
    real locator (email/phone/LinkedIn) and a verification state we can stand
    behind; a locator we have but have not checked is only partially enriched.
    """
    # One authority for the vocabulary: delegate to the outreach scorer so a
    # record can never be READY in one place and PARTIAL in another.
    from .outreach import count_data_points, readiness_from

    completeness, _ = completeness_score(domain, record)
    verified = str(record.get("verification_status") or "").lower() in ("verified", "cross_verified")
    readiness, _ = readiness_from(
        has_verified_locator=bool(verified and has_contact_locator),
        locator_count=contact_locator_count if has_contact_locator else 0,
        completeness=completeness,
        data_points=count_data_points(record),
    )
    return readiness


QUALITY_STATES = (
    "NEW", "DISCOVERED", "NORMALIZED", "ENRICHING", "ENRICHED",
    "VERIFIED", "NEEDS_REVIEW", "STALE", "FAILED",
)


def quality_state(
    domain: str,
    record: dict[str, Any],
    *,
    enrichment_status: Optional[str] = None,
    has_contact_locator: bool = False,
) -> str:
    """Single canonical quality state for the record."""
    enrichment = (enrichment_status or record.get("enrichment_status") or "").upper()
    if enrichment == "FAILED":
        return "FAILED"
    if str(record.get("verification_status") or "").lower() in ("verified", "cross_verified"):
        return "VERIFIED"
    if freshness_category(domain, record) == "stale":
        return "STALE"
    if enrichment == "ENRICHING":
        return "ENRICHING"
    if enrichment == "ENRICHED":
        return "ENRICHED"
    # A reachable contact is what makes a lead actionable, so it outranks the
    # completeness heuristic: a record with a verified placement-cell email is
    # enriched even when most descriptive fields are still blank.
    if has_contact_locator:
        return "ENRICHED"
    completeness, _ = completeness_score(domain, record)
    if completeness < 20:
        return "NEEDS_REVIEW"
    return "NORMALIZED"


# role -> priority. TPO/Placement Head are the people who actually make hiring
# decisions, so they are P0; the principal is a valid but slower path (P1).
COLLEGE_ROLE_PRIORITY = {
    "tpo": "P0",
    "placement_head": "P0",
    "placement_cell": "P0",
    "director": "P1",
    "principal": "P1",
    "dean": "P2",
    "hod": "P2",
    "faculty": "P3",
    "official": "P3",
    "other": "P4",
}

HACKATHON_ROLE_PRIORITY = {
    "outreach": "P0",
    "organizer": "P1",
    "sponsor": "P2",
    "judge": "P3",
}

PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}


def priority_for_role(domain: str, role: Optional[str]) -> str:
    role_key = (role or "").strip().lower()
    table = COLLEGE_ROLE_PRIORITY if domain == "colleges" else HACKATHON_ROLE_PRIORITY
    return table.get(role_key, "P4")


def best_contact_priority(priorities: list[str]) -> Optional[str]:
    """The highest (lowest-numbered) priority present, for list sorting."""
    valid = [p for p in priorities if p in PRIORITY_ORDER]
    if not valid:
        return None
    return sorted(valid, key=lambda p: PRIORITY_ORDER[p])[0]


async def persist_quality(
    conn,
    domain: str,
    entity_id: str,
    record: dict[str, Any],
    *,
    has_contact_locator: bool = False,
    enrichment_status: Optional[str] = None,
    issues: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Compute and store the quality verdict for one entity.

    Quality is written to data_quality_results (one row per domain+entity) so the
    UI and re-enrichment sweep can query it without recomputing, and so a record's
    quality history is auditable. The row is an upsert: the newest verdict replaces
    the previous one, while the entity table keeps its own denormalized copy.
    """
    completeness, computed_issues = completeness_score(domain, record)
    freshness = freshness_score(domain, record)
    verification = verification_score(record)
    contact_quality = (
        "verified" if str(record.get("verification_status") or "").lower() in ("verified", "cross_verified")
        else "locator" if has_contact_locator
        else "none"
    )
    confidence = confidence_score(domain, record, contact_verified=contact_quality == "verified")
    state = quality_state(
        domain, record, enrichment_status=enrichment_status,
        has_contact_locator=has_contact_locator,
    )
    all_issues = sorted({*(issues or []), *computed_issues})
    await conn.execute(
        """INSERT INTO data_quality_results
             (domain, entity_id, completeness_score, freshness_score, verification_score,
              source_quality, contact_quality, confidence, quality_state, issues, computed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
           ON CONFLICT (domain, entity_id) DO UPDATE SET
             completeness_score=EXCLUDED.completeness_score,
             freshness_score=EXCLUDED.freshness_score,
             verification_score=EXCLUDED.verification_score,
             source_quality=EXCLUDED.source_quality,
             contact_quality=EXCLUDED.contact_quality,
             confidence=EXCLUDED.confidence,
             quality_state=EXCLUDED.quality_state,
             issues=EXCLUDED.issues,
             computed_at=NOW()""",
        domain, entity_id, completeness, freshness, verification,
        _source_quality(record), contact_quality, confidence, state,
        json.dumps(all_issues),
    )
    return {
        "quality_state": state,
        "completeness_score": completeness,
        "freshness_score": freshness,
        "verification_score": verification,
        "confidence": confidence,
        "contact_quality": contact_quality,
        "issues": all_issues,
    }


def _source_quality(record: dict[str, Any]) -> Optional[str]:
    """How well the record is corroborated across independent sources."""
    try:
        count = int(record.get("source_count") or 0)
    except (TypeError, ValueError):
        count = 0
    status = str(record.get("verification_status") or "").lower()
    if status in ("cross_verified",) or count >= 3:
        return "high"
    if status == "verified" or count == 2:
        return "medium"
    if count == 1:
        return "single_source"
    return None
