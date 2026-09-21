"""College predictions (placement/admission cycles).

Same contract as hackathon prediction: no evidence, no output. College placement
seasons are predictable only once we have recorded observations for that college
(a placement report year, a recruitment drive page, a past admission window). The
adapters do not yet parse placement reports, so in practice this engine produces
nothing until that data exists — which is the honest outcome and is surfaced as
BLOCKED/EXTERNAL_DEPENDENCY rather than filled with a guess.
"""

from __future__ import annotations

import json
import logging
from datetime import date
from statistics import median
from typing import Any, Optional

from ..hackathons.prediction import LIMITATIONS, MONTH_NAMES, _consistency
from ..normalize import parse_datetime

logger = logging.getLogger(__name__)

METHOD = "observed_cycle_analysis (month distribution over recorded observations)"


def analyze_college_cycle(predictions_type: str, observations: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Predict the next window for a recurring college cycle.

    `observations` must be real dated events (e.g. {'year': 2024, 'start': '...'}).
    Fewer than two dated observations -> None (no fabrication).
    """
    cleaned = []
    for obs in observations or []:
        dt = parse_datetime(obs.get("start") or obs.get("date") or obs.get("period"))
        year = obs.get("year") or (dt.year if dt else None)
        try:
            year = int(year)
        except (TypeError, ValueError):
            continue
        cleaned.append({"year": year, "month": dt.month if dt else None})
    if len(cleaned) < 2:
        return None
    months = [c["month"] for c in cleaned if c["month"]]
    if not months:
        return None
    month = int(median(months))
    years = sorted({c["year"] for c in cleaned})
    next_year = years[-1] + 1
    confidence = min(85, 30 + 15 * (len(cleaned) - 2) + int(_consistency(months) * 20))
    status = "PREDICTED" if confidence >= 55 else "LOW_CONFIDENCE_PREDICTION"
    return {
        "prediction_type": predictions_type,
        "predicted_window": f"{MONTH_NAMES[month - 1]} {next_year}",
        "expected_month": month,
        "confidence": confidence,
        "basis": f"Observed {len(cleaned)} occurrence(s) in {', '.join(MONTH_NAMES[m - 1] for m in sorted(set(months)))}.",
        "evidence": cleaned,
        "method": METHOD,
        "limitations": LIMITATIONS,
        "status": status,
    }


async def generate_college_predictions(conn, run_id: Optional[str] = None, limit: int = 5000) -> dict[str, Any]:
    """Generate college predictions from stored evidence, if any exists.

    Evidence source: `college_sources.raw_payload` may carry an `observations`
    array when a portal publishes placement/admission history. Absent it, this
    run creates zero predictions and says so — it never invents windows.
    """
    run_id = await conn.fetchval(
        "INSERT INTO prediction_runs (domain, status, method) VALUES ('colleges','running',$1) RETURNING id",
        METHOD,
    )
    rows = await conn.fetch(
        """
        SELECT college_id, raw_payload
          FROM college_sources
         WHERE raw_payload ? 'observations'
         LIMIT $1
        """,
        limit,
    )
    created = 0
    for row in rows:
        payload = row["raw_payload"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except (ValueError, TypeError):
                continue
        observations = payload.get("observations") if isinstance(payload, dict) else None
        prediction = analyze_college_cycle("placement_season", observations or [])
        if not prediction:
            continue
        await conn.execute(
            """
            INSERT INTO college_predictions
              (college_id, prediction_type, predicted_window, expected_month, confidence,
               basis, evidence, method, limitations, run_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
            """,
            row["college_id"], prediction["prediction_type"], prediction["predicted_window"],
            prediction["expected_month"], prediction["confidence"], prediction["basis"],
            json.dumps(prediction["evidence"], default=str), prediction["method"],
            prediction["limitations"], run_id,
        )
        created += 1
    await conn.execute(
        """UPDATE prediction_runs SET status='completed', entities_processed=$2,
             predictions_created=$3, finished_at=NOW() WHERE id=$1""",
        run_id, len(rows), created,
    )
    return {
        "run_id": str(run_id), "evidence_rows": len(rows), "predictions_created": created,
        "note": "0 predictions means no recorded placement-cycle evidence — not an error",
    }
