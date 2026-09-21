"""College pipeline: normalize raw, enrich contacts, predict cycles, snapshot EDA."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Bounded per run so a single army execution cannot become an unbounded crawl.
REENRICH_LIMIT = 25


async def run_college_pipeline(db_pool, run_id: Optional[str], *, fetch_pages: bool = True, enrich_limit: int = 50) -> dict[str, Any]:
    from .eda import snapshot_college_eda
    from .enrichment import enrich_college, enrich_pending_colleges
    from .normalizer import process_pending_raw
    from .prediction import generate_college_predictions

    if db_pool is None:
        return {"error": "no_database"}
    result: dict[str, Any] = {}
    async with db_pool.acquire() as conn:
        result["normalize"] = await process_pending_raw(conn, "colleges")
        result["enrich"] = await enrich_pending_colleges(conn, limit=enrich_limit, fetch_pages=fetch_pages)
        # Records still missing a reachable contact are re-queued automatically
        # (bounded, cooldown-limited) instead of waiting for someone to notice.
        from ..reenrich import run_reenrichment_sweep
        result["reenrich"] = await run_reenrichment_sweep(
            conn, "colleges", limit=REENRICH_LIMIT, fetch_pages=fetch_pages, enrich_one=enrich_college
        )
        result["prediction"] = await generate_college_predictions(conn, run_id=run_id)
        try:
            result["eda"] = await snapshot_college_eda(conn)
        except Exception as e:  # noqa: BLE001
            logger.warning("college EDA snapshot failed: %s", e)
            result["eda_error"] = str(e)[:200]
    return result
