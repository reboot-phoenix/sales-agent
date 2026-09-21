"""Hackathon recurrence prediction.

Evidence-driven and deliberately conservative. The engine only predicts from
recorded historical occurrences, labels every output PREDICTED /
LOW_CONFIDENCE_PREDICTION (never CONFIRMED), states the method, the observations
used and the limitations, and refuses to emit anything when there is no basis.

Method: month-of-year distribution + inter-year interval analysis (a classical
seasonal/recurrence approach). No ML is used because the data volume per event is
tiny — a model would only manufacture precision.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from statistics import median
from typing import Any, Optional

from ..normalize import parse_datetime

logger = logging.getLogger(__name__)

METHOD = "historical_recurrence_analysis (month distribution + inter-year interval)"
LIMITATIONS = (
    "Based only on recorded historical occurrences; a one-off cancellation, a "
    "change of month, or an organizer hiatus cannot be foreseen. Treat as a "
    "planning signal, not a confirmed date."
)

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def analyze_recurrence(occurrences: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Compute a recurrence prediction from an event's occurrence history.

    Returns None when there is not enough evidence to say anything honest.
    """
    cleaned: list[dict[str, Any]] = []
    for occ in occurrences or []:
        year = _int(occ.get("year"))
        if year is None:
            stamp = (
                parse_datetime(occ.get("event_start"))
                or parse_datetime(occ.get("event_end"))
                or parse_datetime(occ.get("registration_start"))
            )
            year = stamp.year if stamp else None
        if year is None:
            continue
        start = parse_datetime(occ.get("event_start")) or parse_datetime(occ.get("registration_start"))
        cleaned.append({
            "year": year,
            "start": start,
            "month": start.month if start else None,
            "day": start.day if start else None,
            "source_url": occ.get("source_url"),
            "registration_start": parse_datetime(occ.get("registration_start")),
            "registration_deadline": parse_datetime(occ.get("registration_deadline")),
        })
    if len(cleaned) < 2:
        return None
    cleaned.sort(key=lambda o: o["year"])
    years = sorted({o["year"] for o in cleaned})
    if len(years) < 2:
        return None

    intervals = [years[i + 1] - years[i] for i in range(len(years) - 1)]
    typical_interval = int(median(intervals))
    months = [o["month"] for o in cleaned if o["month"]]
    month = int(median(months)) if months else None
    days = [o["day"] for o in cleaned if o["day"]]
    day = int(median(days)) if days else 15  # mid-month when only a month is known
    month_consistency = _consistency(months)
    regular = typical_interval == 1 and all(i == 1 for i in intervals)
    recurring = typical_interval >= 1 and _consistency(intervals) >= 0.5

    # Confidence: base from sample size, bonus for a consistent month and a
    # regular annual cadence, penalty for irregular gaps. Capped at 90 — a
    # prediction is never certain by construction.
    n = len(cleaned)
    confidence = 35 + 15 * (n - 2)
    if month_consistency >= 0.8:
        confidence += 15
    elif month_consistency >= 0.5:
        confidence += 7
    if regular:
        confidence += 10
    if not recurring:
        confidence -= 20
    confidence = max(10, min(90, int(confidence)))

    next_year = years[-1] + typical_interval
    if typical_interval <= 0:
        typical_interval = 1
        next_year = years[-1] + 1
    predicted_date: Optional[date] = None
    if month:
        try:
            predicted_date = date(next_year, month, min(day, 28))
        except ValueError:
            predicted_date = None

    # A dated prediction needs BOTH a recurrence signal and enough history to
    # justify it. Two observations can establish that a pattern exists, but
    # they are never enough to publish a date as a prediction — for that we
    # require a third observation, or an unusually strong two-point signal.
    if not recurring:
        status = "LOW_CONFIDENCE_PREDICTION"
    elif n >= 3 and confidence >= 60:
        status = "PREDICTED"
    else:
        status = "RECURRING_PATTERN"

    observed = ", ".join(
        f"{MONTH_NAMES[o['month'] - 1]} {o['year']}" if o["month"] else str(o["year"])
        for o in cleaned
    )
    evidence = [
        {
            "year": o["year"],
            "month": o["month"],
            "event_start": o["start"].date().isoformat() if o["start"] else None,
            "source_url": o["source_url"],
        }
        for o in cleaned
    ]
    window = None
    reg_months = [o["registration_start"].month for o in cleaned if o["registration_start"]]
    if reg_months:
        lo, hi = min(reg_months), max(reg_months)
        window = f"{MONTH_NAMES[lo - 1]}–{MONTH_NAMES[hi - 1]}"

    return {
        "occurrence_type": "recurring" if recurring else "irregular_or_once",
        "recurrence_pattern": f"every {typical_interval} year(s)" if recurring else "irregular",
        "historical_years": years,
        "predicted_occurrence": predicted_date.isoformat() if predicted_date else None,
        "expected_month": month,
        "expected_registration_window": window,
        "prediction_confidence": confidence,
        "prediction_basis": (
            f"Observed {n} occurrence(s): {observed}. Median interval "
            f"{typical_interval} year(s); month consistency {month_consistency:.0%}."
        ),
        "evidence": evidence,
        "historical_observations": n,
        "method": METHOD,
        "limitations": LIMITATIONS,
        "status": status,
    }


def _consistency(values: list[int]) -> float:
    """Share of values equal to the mode. 1.0 = perfectly consistent."""
    if not values:
        return 0.0
    counts: dict[int, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return max(counts.values()) / len(values)


def _int(value: Any) -> Optional[int]:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


async def generate_hackathon_predictions(conn, run_id: Optional[str] = None, limit: int = 2000) -> dict[str, Any]:
    """Recompute predictions for every hackathon with occurrence history.

    Writes a hackathon_predictions row (append-only evidence) and refreshes the
    denormalized prediction summary on the hackathon itself. A hackathon with too
    little history is left untouched rather than given a fabricated guess.
    """
    run_id = await conn.fetchval(
        "INSERT INTO prediction_runs (domain, status, method) VALUES ('hackathons','running',$1) RETURNING id",
        METHOD,
    )
    created = 0
    processed = 0
    rows = await conn.fetch(
        """
        SELECT h.id, h.name,
               COALESCE(json_agg(json_build_object(
                   'year', o.year, 'event_start', o.event_start, 'event_end', o.event_end,
                   'registration_start', o.registration_start,
                   'registration_deadline', o.registration_deadline,
                   'source_url', o.source_url
               ) ORDER BY o.year) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS occurrences
          FROM hackathons h
          LEFT JOIN hackathon_occurrences o ON o.hackathon_id = h.id
         WHERE h.is_active
         GROUP BY h.id, h.name
         HAVING COUNT(o.id) >= 2
         ORDER BY h.last_seen_at DESC
         LIMIT $1
        """,
        limit,
    )
    for row in rows:
        processed += 1
        occurrences = row["occurrences"]
        if isinstance(occurrences, str):
            occurrences = json.loads(occurrences)
        prediction = analyze_recurrence(occurrences or [])
        if not prediction:
            continue
        await conn.execute(
            """
            INSERT INTO hackathon_predictions
              (hackathon_id, predicted_occurrence, expected_month,
               expected_registration_window, confidence, basis, evidence,
               historical_observations, method, limitations, status, run_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
            """,
            row["id"], prediction["predicted_occurrence"], prediction["expected_month"],
            prediction["expected_registration_window"], prediction["prediction_confidence"],
            prediction["prediction_basis"], json.dumps(prediction["evidence"], default=str),
            prediction["historical_observations"], prediction["method"],
            prediction["limitations"], prediction["status"], run_id,
        )
        await conn.execute(
            """
            UPDATE hackathons SET
              occurrence_type=$2, recurrence_pattern=$3, historical_years=$4::jsonb,
              predicted_occurrence=$5, prediction_confidence=$6, prediction_basis=$7,
              expected_month=$8, expected_registration_window=$9,
              prediction_generated_at=NOW(), updated_at=NOW()
            WHERE id=$1
            """,
            row["id"], prediction["occurrence_type"], prediction["recurrence_pattern"],
            json.dumps(prediction["historical_years"]),
            prediction["predicted_occurrence"], prediction["prediction_confidence"],
            prediction["prediction_basis"], prediction["expected_month"],
            prediction["expected_registration_window"],
        )
        created += 1
    await conn.execute(
        "UPDATE prediction_runs SET status='completed', entities_processed=$2, predictions_created=$3, finished_at=NOW() WHERE id=$1",
        run_id, processed, created,
    )
    return {"run_id": str(run_id), "entities_processed": processed, "predictions_created": created}
