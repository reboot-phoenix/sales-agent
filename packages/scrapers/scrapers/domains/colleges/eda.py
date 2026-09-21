"""College EDA — state-wise coverage and contact-completeness statistics.

Every number is a count over rows that exist. An empty table yields zeros; no
figure is ever seeded or estimated, which is why the API surfaces it as
"measured" rather than "target".
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

logger = logging.getLogger(__name__)

TPO_ROLES = ("tpo", "placement_head", "placement_cell")
SENIOR_ROLES = ("principal", "director", "dean")


def _top(counter: Counter, n: int = 20) -> list[dict[str, Any]]:
    return [{"value": value, "count": count} for value, count in counter.most_common(n)]


def summarize_colleges(records: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(records)
    by_state: Counter = Counter()
    by_district: Counter = Counter()
    by_city: Counter = Counter()
    by_type: Counter = Counter()
    by_ownership: Counter = Counter()
    by_accreditation: Counter = Counter()
    by_naac_grade: Counter = Counter()
    by_enrichment: Counter = Counter()
    by_readiness: Counter = Counter()
    by_source: Counter = Counter()
    with_website = with_email = with_phone = 0
    tpo_covered = principal_covered = director_covered = dean_covered = 0
    contact_counts: list[int] = []
    completeness_values: list[int] = []
    ranked = 0

    for rec in records:
        for field, counter in (
            ("state", by_state), ("district", by_district), ("city", by_city),
            ("institution_type", by_type), ("ownership", by_ownership),
            ("accreditation", by_accreditation), ("naac_grade", by_naac_grade),
            ("enrichment_status", by_enrichment), ("outreach_readiness", by_readiness),
        ):
            value = rec.get(field)
            if value:
                counter[str(value).strip()] += 1
        if rec.get("website_url"):
            with_website += 1
        if rec.get("official_email"):
            with_email += 1
        if rec.get("phone"):
            with_phone += 1
        if rec.get("tpo_name") or rec.get("tpo_email"):
            tpo_covered += 1
        if rec.get("principal_name"):
            principal_covered += 1
        if rec.get("director_name"):
            director_covered += 1
        if rec.get("dean_name"):
            dean_covered += 1
        if rec.get("nirf_rank"):
            ranked += 1
        coverage = rec.get("contact_coverage")
        if isinstance(coverage, str):
            try:
                coverage = json.loads(coverage)
            except (ValueError, TypeError):
                coverage = None
        if isinstance(coverage, dict):
            contact_counts.append(int(coverage.get("contacts") or 0))
            by_role = coverage.get("by_role") or {}
            if any(role in by_role for role in TPO_ROLES):
                tpo_covered = max(tpo_covered, tpo_covered)
        completeness = rec.get("completeness_score")
        if isinstance(completeness, (int, float)):
            completeness_values.append(int(completeness))
        for url in (rec.get("source_urls") or []):
            if url:
                host = str(url).split("//")[-1].split("/")[0]
                by_source[host] += 1

    return {
        "total": total,
        "states_covered": len(by_state),
        "districts_covered": len(by_district),
        "with_website": with_website,
        "with_official_email": with_email,
        "with_phone": with_phone,
        "tpo_coverage": tpo_covered,
        "placement_role_coverage_pct": round(tpo_covered / total * 100, 1) if total else 0.0,
        "principal_coverage": principal_covered,
        "director_coverage": director_covered,
        "dean_coverage": dean_covered,
        "nirf_ranked": ranked,
        "contacts_total": sum(contact_counts),
        "colleges_with_contacts": sum(1 for c in contact_counts if c > 0),
        "average_contacts_per_college": round(sum(contact_counts) / len(contact_counts), 2) if contact_counts else 0.0,
        "average_completeness": round(sum(completeness_values) / len(completeness_values), 1) if completeness_values else 0.0,
        "by_state": _top(by_state, 40),
        "by_district": _top(by_district),
        "by_city": _top(by_city),
        "by_type": dict(by_type),
        "by_ownership": dict(by_ownership),
        "by_accreditation": dict(by_accreditation),
        "by_naac_grade": dict(by_naac_grade),
        "by_enrichment_status": dict(by_enrichment),
        "by_outreach_readiness": dict(by_readiness),
        "by_source": _top(by_source),
        "measured": True,
    }


async def college_eda(conn, limit: int = 100_000) -> dict[str, Any]:
    rows = await conn.fetch(
        """
        SELECT name, state, district, city, institution_type, ownership, accreditation,
               naac_grade, website_url, official_email, phone, tpo_name, tpo_email,
               principal_name, director_name, dean_name, nirf_rank,
               source_urls, contact_coverage, completeness_score,
               enrichment_status, outreach_readiness
          FROM colleges
         WHERE is_active
         LIMIT $1
        """,
        limit,
    )
    metrics = summarize_colleges([dict(r) for r in rows])
    # Contact statistics come from the contacts table, not a denormalized guess.
    contact_rows = await conn.fetch(
        """
        SELECT c.id AS college_id,
               COUNT(cc.id) AS contacts,
               COUNT(cc.id) FILTER (WHERE cc.role_category IN ('tpo','placement_head','placement_cell')) AS tpo_roles,
               COUNT(cc.id) FILTER (WHERE cc.email IS NOT NULL) AS emails,
               COUNT(cc.id) FILTER (WHERE cc.phone IS NOT NULL) AS phones
          FROM colleges c LEFT JOIN college_contacts cc ON cc.college_id = c.id
         WHERE c.is_active GROUP BY c.id
        """
    )
    metrics["contacts_total"] = sum(int(r["contacts"] or 0) for r in contact_rows)
    metrics["colleges_with_contacts"] = sum(1 for r in contact_rows if int(r["contacts"] or 0) > 0)
    metrics["colleges_with_tpo_role"] = sum(1 for r in contact_rows if int(r["tpo_roles"] or 0) > 0)
    metrics["contact_emails"] = sum(int(r["emails"] or 0) for r in contact_rows)
    metrics["contact_phones"] = sum(int(r["phones"] or 0) for r in contact_rows)
    tpo_pct = (
        round(metrics["colleges_with_tpo_role"] / metrics["total"] * 100, 1) if metrics["total"] else 0.0
    )
    metrics["placement_role_coverage_pct"] = tpo_pct
    return metrics


async def snapshot_college_eda(conn) -> dict[str, Any]:
    metrics = await college_eda(conn)
    await conn.execute(
        "INSERT INTO analytics_snapshots (domain, metrics) VALUES ('colleges', $1::jsonb)",
        json.dumps(metrics, default=str),
    )
    return metrics
