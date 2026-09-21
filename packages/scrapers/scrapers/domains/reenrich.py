"""Automatic re-enrichment.

A lead only earns its keep once somebody can actually be contacted, so records
whose contacts are missing, weak, or whose sources have gone stale are re-queued
without a human asking. Three properties matter here:

* **Bounded** — a sweep never turns one army run into an unbounded crawl; the
  caller passes a limit and it is clamped again here.
* **Rate-limited** — an entity attempted within the cooldown window is skipped,
  so a page that legitimately has no public contact does not get hammered every
  night. The cooldown is a SQL literal, never interpolated from input.
* **Isolated** — one entity failing (site down, parse error) is logged and the
  sweep continues; the failure is recorded in enrichment_runs by the enricher.

Priority follows outreach value, not row order: upcoming hackathons first (the
window is closing), then the most complete colleges (the highest-yield records),
then everything else.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

EnrichOne = Callable[..., Awaitable[dict[str, Any]]]

# Table names are interpolated into SQL, so they only ever come from this closed
# map — never from a caller.
DOMAIN_TABLES: dict[str, str] = {"hackathons": "hackathons", "colleges": "colleges"}

# Domain-specific staleness window and best-available URL expression.
_STALE_WINDOW: dict[str, str] = {"hackathons": "10 days", "colleges": "120 days"}
_URL_EXPR: dict[str, str] = {
    "hackathons": "COALESCE(t.hackathon_url, t.organizer_website, t.source_url)",
    "colleges": "COALESCE(t.website_url, t.source_urls->>0)",
}
# Closing windows first for events, highest-value first for institutions.
_ORDER_BY: dict[str, str] = {
    "hackathons": (
        "(t.registration_deadline >= NOW()) DESC NULLS LAST, "
        "COALESCE(t.event_start, t.registration_start) ASC NULLS LAST, "
        "t.created_at DESC"
    ),
    "colleges": "t.completeness_score DESC, t.created_at DESC",
}

COOLDOWN_HOURS = 6
MAX_LIMIT = 200


def _clamp(limit: int) -> int:
    try:
        return max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        return 25


def _candidate_sql(domain: str) -> str:
    """The re-enrichment candidate query for one domain (no user input inside)."""
    if domain not in DOMAIN_TABLES:
        raise ValueError(f"unknown re-enrichment domain: {domain}")
    table = DOMAIN_TABLES[domain]
    stale = _STALE_WINDOW[domain]
    url_expr = _URL_EXPR[domain]
    return f"""
        SELECT t.id, t.name, t.outreach_readiness, t.enrichment_status, t.freshness_category
          FROM {table} t
         WHERE t.is_active
           AND {url_expr} IS NOT NULL
           AND (
                 (t.contact_email IS NULL AND t.contact_phone IS NULL AND t.contact_linkedin IS NULL)
              OR t.outreach_readiness IN ('NEEDS_ENRICHMENT', 'INSUFFICIENT_DATA')
              OR t.enrichment_status IN ('NEW', 'NEEDS_ENRICHMENT', 'FAILED')
              OR t.freshness_category = 'stale'
              OR t.last_seen_at < NOW() - INTERVAL '{stale}'
           )
           AND NOT EXISTS (
                 SELECT 1 FROM enrichment_runs er
                  WHERE er.domain = '{domain}' AND er.entity_id = t.id
                    AND er.started_at > NOW() - INTERVAL '{COOLDOWN_HOURS} hours'
           )
         ORDER BY {_ORDER_BY[domain]}
         LIMIT $1
    """


async def select_reenrichment_candidates(conn, domain: str, limit: int = 25) -> list[dict[str, Any]]:
    """Entities that need (re-)enrichment right now, highest value first."""
    if domain not in DOMAIN_TABLES:
        raise ValueError(f"unknown re-enrichment domain: {domain}")
    rows = await conn.fetch(_candidate_sql(domain), _clamp(limit))
    return [dict(r) for r in rows]


def _default_enricher(domain: str) -> EnrichOne:
    """The per-entity enrichment entry point for a domain (imported lazily)."""
    if domain == "hackathons":
        from .hackathons.worker import enrich_hackathon_by_id

        return enrich_hackathon_by_id
    if domain == "colleges":
        from .colleges.enrichment import enrich_college

        return enrich_college
    raise ValueError(f"unknown re-enrichment domain: {domain}")


async def run_reenrichment_sweep(
    conn,
    domain: str,
    *,
    limit: int = 25,
    fetch_pages: bool = True,
    enrich_one: Optional[EnrichOne] = None,
    cooldown_hours: int = COOLDOWN_HOURS,
) -> dict[str, Any]:
    """Re-enrich up to ``limit`` candidates for one domain.

    Returns a per-run report so the army run can show what it did: how many
    candidates were selected, how many were enriched, how many contacts were
    added, and which entities failed (with the reason, never silently dropped).
    """
    if domain not in DOMAIN_TABLES:
        raise ValueError(f"unknown re-enrichment domain: {domain}")
    if cooldown_hours != COOLDOWN_HOURS:
        logger.debug("cooldown override ignored: %s", cooldown_hours)
    enricher = enrich_one or _default_enricher(domain)
    candidates = await select_reenrichment_candidates(conn, domain, limit)
    report: dict[str, Any] = {
        "domain": domain,
        "candidates": len(candidates),
        "attempted": 0,
        "enriched": 0,
        "contacts_inserted": 0,
        "errors": [],
    }
    for candidate in candidates:
        entity_id = str(candidate.get("id"))
        report["attempted"] += 1
        try:
            result = await enricher(conn, entity_id, fetch_pages=fetch_pages) or {}
        except Exception as e:  # noqa: BLE001 - one entity must never abort the sweep
            logger.warning("re-enrichment failed for %s %s: %s", domain, entity_id, e)
            report["errors"].append({"entity_id": entity_id, "error": str(e)[:200]})
            continue
        status = str(result.get("status") or "")
        if status and status not in ("completed", "ok"):
            report["errors"].append({"entity_id": entity_id, "error": status})
            continue
        inserted = int(result.get("contacts_inserted") or result.get("contacts") or 0)
        report["contacts_inserted"] += inserted
        if inserted or result.get("readiness") == "OUTREACH_READY":
            report["enriched"] += 1
    return report


async def run_all_reenrichment(db_pool, *, limit: int = 25, fetch_pages: bool = True) -> dict[str, Any]:
    """Sweep every domain — used by the nightly maintenance pass."""
    if db_pool is None:
        return {"error": "no_database"}
    reports: dict[str, Any] = {}
    async with db_pool.acquire() as conn:
        for domain in DOMAIN_TABLES:
            try:
                reports[domain] = await run_reenrichment_sweep(
                    conn, domain, limit=limit, fetch_pages=fetch_pages
                )
            except Exception as e:  # noqa: BLE001 - domains are independent
                logger.warning("re-enrichment sweep failed for %s: %s", domain, e)
                reports[domain] = {"error": str(e)[:200]}
    return reports
