"""Hackathon EDA — real statistics over collected data.

Two entry points: ``summarize_hackathons(records)`` is pure and unit-testable;
``hackathon_eda(conn)`` pulls a projection from Postgres and calls it. Nothing is
manufactured: each figure is a count/average over rows that actually exist, and an
empty dataset yields zeros (never a seeded/example number).
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any, Optional

from ..normalize import parse_datetime

logger = logging.getLogger(__name__)

PRIZE_BUCKETS = (
    ("no_prize", 0, 0),
    ("under_50k", 1, 50_000),
    ("50k_to_2L", 50_001, 200_000),
    ("2L_to_5L", 200_001, 500_000),
    ("above_5L", 500_001, None),
)


def _top(counter: Counter, n: int = 15) -> list[dict[str, Any]]:
    return [{"value": value, "count": count} for value, count in counter.most_common(n)]


def summarize_hackathons(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate statistics over hackathon rows (dicts from the DB or normalizer)."""
    total = len(records)
    by_month: Counter = Counter()
    by_state: Counter = Counter()
    by_city: Counter = Counter()
    by_organizer: Counter = Counter()
    by_technology: Counter = Counter()
    by_domain: Counter = Counter()
    by_mode: Counter = Counter()
    by_source: Counter = Counter()
    by_status: Counter = Counter()
    by_year: Counter = Counter()
    prize_buckets: Counter = Counter()
    prizes: list[float] = []
    student_only = college_only = open_to_public = 0
    hiring_linked = internship_linked = 0
    recurring_organizers = 0
    upcoming = registration_open = registration_closing_soon = predicted = historical = 0
    recurring_hackathons = 0

    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    soon = now + timedelta(days=14)

    for rec in records:
        start = parse_datetime(rec.get("event_start") or rec.get("registration_start"))
        if start:
            by_month[start.month] += 1
            by_year[start.year] += 1
        for field, counter in (
            ("state", by_state), ("city", by_city), ("organizer_name", by_organizer),
            ("technology", by_technology), ("domain", by_domain),
            ("mode", by_mode), ("source_platform", by_source), ("status", by_status),
        ):
            value = rec.get(field)
            if value:
                counter[str(value).strip()] += 1
        prize = rec.get("prize_pool")
        try:
            prize_val = float(prize) if prize not in (None, "") else None
        except (TypeError, ValueError):
            prize_val = None
        if prize_val is not None:
            prizes.append(prize_val)
            for name, lo, hi in PRIZE_BUCKETS:
                if hi is None:
                    if prize_val >= lo:
                        prize_buckets[name] += 1
                        break
                elif lo <= prize_val <= hi:
                    prize_buckets[name] += 1
                    break
        else:
            prize_buckets["unknown"] += 1
        if rec.get("student_only") is True:
            student_only += 1
        if rec.get("college_only") is True:
            college_only += 1
        if rec.get("open_to_public") is True:
            open_to_public += 1
        if rec.get("hiring_opportunities") is True:
            hiring_linked += 1
        if rec.get("internship_opportunities") is True:
            internship_linked += 1
        if (rec.get("occurrence_type") or "") == "recurring":
            recurring_hackathons += 1
        status = str(rec.get("status") or "").upper()
        if status == "HISTORICAL":
            historical += 1
        elif status in ("PREDICTED", "LOW_CONFIDENCE_PREDICTION", "RECURRING_PATTERN"):
            predicted += 1
        else:
            event_start = parse_datetime(rec.get("event_start"))
            reg_end = parse_datetime(rec.get("registration_deadline"))
            if event_start and event_start >= now:
                upcoming += 1
            if reg_end and reg_end >= now:
                registration_open += 1
            if reg_end and now <= reg_end <= soon:
                registration_closing_soon += 1

    recurring_orgs = [org for org, count in by_organizer.items() if count >= 2]
    recurring_organizers = len(recurring_orgs)

    return {
        "total": total,
        "upcoming": upcoming,
        "registration_open": registration_open,
        "registration_closing_soon": registration_closing_soon,
        "historical": historical,
        "predicted": predicted,
        "recurring_hackathons": recurring_hackathons,
        "recurring_organizers": recurring_organizers,
        "student_only": student_only,
        "college_only": college_only,
        "open_to_public": open_to_public,
        "hiring_linked": hiring_linked,
        "internship_linked": internship_linked,
        "average_prize_pool": round(sum(prizes) / len(prizes), 2) if prizes else None,
        # Every defined bucket is always present, so a chart can render a
        # genuine zero instead of an ambiguous missing key.
        "prize_buckets": {
            **{name: prize_buckets.get(name, 0) for name, _, _ in PRIZE_BUCKETS},
            "unknown": prize_buckets.get("unknown", 0),
        },
        "by_month": {str(k): v for k, v in sorted(by_month.items())},
        "by_year": {str(k): v for k, v in sorted(by_year.items())},
        "by_state": _top(by_state),
        "by_city": _top(by_city),
        "by_organizer": _top(by_organizer),
        "by_technology": _top(by_technology),
        "by_domain": _top(by_domain),
        "by_mode": dict(by_mode),
        "by_source": _top(by_source),
        "by_status": dict(by_status),
        "generated_at": now.isoformat(),
    }


async def hackathon_eda(conn, limit: int = 50_000) -> dict[str, Any]:
    """Load the projection and summarize. Empty table -> all-zero structure."""
    rows = await conn.fetch(
        """
        SELECT name, organizer_name, event_start, registration_start, registration_deadline,
               venue, city, state, country, mode, technology, domain, prize_pool,
               student_only, college_only, open_to_public,
               hiring_opportunities, internship_opportunities,
               source_platform, status, occurrence_type
          FROM hackathons
         WHERE is_active
         ORDER BY last_seen_at DESC
         LIMIT $1
        """,
        limit,
    )
    return summarize_hackathons([dict(r) for r in rows])


async def snapshot_hackathon_eda(conn) -> dict[str, Any]:
    """Persist an analytics snapshot and return it."""
    metrics = await hackathon_eda(conn)
    await conn.execute(
        "INSERT INTO analytics_snapshots (domain, metrics) VALUES ('hackathons', $1::jsonb)",
        json.dumps(metrics, default=str),
    )
    return metrics
