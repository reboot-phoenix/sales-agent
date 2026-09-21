"""Hackathon pipeline: enrich organizer contacts, predict recurrence, snapshot EDA."""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..colleges.enrichment import extract_role_contacts
from ..outreach import assess_lead, persist_assessment
from ..quality import (
    completeness_score,
    confidence_score,
    freshness_category,
    persist_quality,
    priority_for_role,
    verification_score,
)

logger = logging.getLogger(__name__)

# Bounded per run: re-enrichment must never turn one army run into an unbounded
# crawl. The sweep also skips entities attempted recently (see domains/reenrich.py).
REENRICH_LIMIT = 25


async def _upsert_hackathon_contact(conn, hackathon_id: str, contact: dict[str, Any]) -> bool:
    """Insert a hackathon contact, backfilling but never downgrading an existing one."""
    email = contact.get("email")
    phone = contact.get("phone")
    linkedin = contact.get("linkedin_url")
    existing = None
    if email:
        existing = await conn.fetchrow(
            "SELECT * FROM hackathon_contacts WHERE hackathon_id=$1 AND lower(email)=lower($2) LIMIT 1",
            hackathon_id, email,
        )
    if existing is None and linkedin:
        existing = await conn.fetchrow(
            "SELECT * FROM hackathon_contacts WHERE hackathon_id=$1 AND lower(linkedin_url)=lower($2) LIMIT 1",
            hackathon_id, linkedin,
        )
    if existing:
        await conn.execute(
            """UPDATE hackathon_contacts SET
                 full_name=COALESCE(full_name,$2), designation=COALESCE(designation,$3),
                 phone=COALESCE(phone,$4), linkedin_url=COALESCE(linkedin_url,$5),
                 confidence_score=GREATEST(confidence_score,$6), updated_at=NOW()
               WHERE id=$1""",
            existing["id"], contact.get("full_name"), contact.get("designation"),
            phone, linkedin, int(contact.get("confidence_score") or 0),
        )
        return False
    await conn.execute(
        """INSERT INTO hackathon_contacts
             (hackathon_id, full_name, designation, role_category, email, phone,
              linkedin_url, priority, contact_source, source_url, verification_status, confidence_score)
           VALUES ($1,$2,$3,'organizer',$4,$5,$6,$7,$8,$9,'unverified',$10)""",
        hackathon_id, contact.get("full_name"), contact.get("designation"), email, phone,
        linkedin, priority_for_role("hackathons", "organizer"), contact.get("contact_source"),
        contact.get("source_url"), int(contact.get("confidence_score") or 0),
    )
    return True


async def recompute_hackathon_quality(conn, hackathon_id: str) -> dict[str, Any]:
    """Refresh readiness/confidence/denormalized contact from stored contacts."""
    row = await conn.fetchrow("SELECT * FROM hackathons WHERE id=$1", hackathon_id)
    if not row:
        return {}
    hackathon = dict(row)
    contacts = [dict(c) for c in await conn.fetch(
        "SELECT * FROM hackathon_contacts WHERE hackathon_id=$1 ORDER BY priority", hackathon_id
    )]
    best = min(contacts, key=lambda c: {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}.get(c.get("priority"), 9)) if contacts else None
    has_locator = bool(contacts)
    updates: dict[str, Any] = {}
    if best:
        updates = {
            "contact_name": best.get("full_name"),
            "contact_designation": best.get("designation"),
            "contact_email": best.get("email"),
            "contact_phone": best.get("phone"),
            "contact_linkedin": best.get("linkedin_url"),
            "contact_source": best.get("contact_source"),
            "outreach_priority": best.get("priority"),
        }
    merged = {**hackathon, **{k: v for k, v in updates.items() if v}}
    completeness, _ = completeness_score("hackathons", merged)
    # Readiness and sendability come from the shared outreach scorer, so this
    # domain can never disagree with the API about what "ready" means.
    assessment = assess_lead("hackathons", merged, contacts)
    readiness = assessment.readiness
    await conn.execute(
        """UPDATE hackathons SET
             contact_name=$2, contact_designation=$3, contact_email=$4, contact_phone=$5,
             contact_linkedin=$6, contact_source=$7, outreach_priority=$8,
             completeness_score=$9, confidence_score=$10, freshness_category=$11,
             outreach_readiness=$12, enrichment_status=$13, updated_at=NOW()
           WHERE id=$1""",
        hackathon_id, updates.get("contact_name"), updates.get("contact_designation"),
        updates.get("contact_email"), updates.get("contact_phone"),
        updates.get("contact_linkedin"), updates.get("contact_source"),
        updates.get("outreach_priority"), completeness,
        confidence_score("hackathons", merged), freshness_category("hackathons", hackathon),
        readiness, "ENRICHED" if has_locator else hackathon.get("enrichment_status"),
    )
    await persist_assessment(conn, assessment)
    # Persist the verdict so the UI, analytics and the re-enrichment sweep can read
    # it without recomputing, and so a record's quality is auditable over time.
    await persist_quality(
        conn, "hackathons", hackathon_id, merged,
        has_contact_locator=has_locator,
        enrichment_status="ENRICHED" if has_locator else hackathon.get("enrichment_status"),
    )
    return {"contacts": len(contacts), "readiness": readiness, "completeness": completeness,
            "outreach_score": assessment.score, "outreach_priority": assessment.priority}


async def _fetch_and_store_contacts(conn, hackathon_id: str, urls: list[str], *, limit: int = 3) -> int:
    """Fetch public pages and store any role contacts found. Returns rows inserted."""
    from ...utils.http_client import fetch

    inserted = 0
    for url in urls[:limit]:
        try:
            resp = await fetch(url, timeout=25, min_engine="httpx", max_engine="playwright")
        except Exception as e:  # noqa: BLE001 - one page failing is not a run failure
            logger.debug("hackathon enrich fetch failed %s: %s", url, e)
            continue
        if resp.status != 200 or not resp.text:
            continue
        for contact in extract_role_contacts(resp.text, url):
            contact["contact_source"] = "hackathon_page"
            try:
                if await _upsert_hackathon_contact(conn, hackathon_id, contact):
                    inserted += 1
            except Exception as e:  # noqa: BLE001
                logger.debug("contact upsert failed: %s", e)
    return inserted


async def _provider_fallback(conn, hackathon_id: str, *, website_url: Optional[str]) -> tuple[int, list[str]]:
    """Last resort for organizer contacts: credentialed providers (if configured)."""
    from ..providers import enrich_with_providers

    result = await enrich_with_providers(website_domain=website_url, limit=10)
    inserted = 0
    for contact in result.get("contacts") or []:
        contact["contact_source"] = contact.get("contact_source") or "provider_api"
        try:
            if await _upsert_hackathon_contact(conn, hackathon_id, contact):
                inserted += 1
        except Exception as e:  # noqa: BLE001
            logger.debug("provider contact upsert failed: %s", e)
    return inserted, list(result.get("providers_used") or [])


async def enrich_hackathon_contacts(conn, limit: int = 40, *, fetch_pages: bool = True) -> dict[str, int]:
    """Discover organizer contacts from the event/ organiser pages already on record."""
    rows = await conn.fetch(
        """
        SELECT id, hackathon_url, registration_url, organizer_website, source_url
          FROM hackathons
         WHERE is_active
           AND (contact_email IS NULL AND contact_phone IS NULL AND contact_linkedin IS NULL)
           AND COALESCE(hackathon_url, organizer_website, source_url) IS NOT NULL
         ORDER BY created_at DESC
         LIMIT $1
        """,
        limit,
    )
    processed = enriched = inserted = 0
    for row in rows:
        processed += 1
        urls = [u for u in (row["hackathon_url"], row["organizer_website"], row["source_url"]) if u]
        if not fetch_pages or not urls:
            continue
        before = inserted
        inserted += await _fetch_and_store_contacts(conn, str(row["id"]), urls, limit=2)
        if inserted == before:
            # Nothing on the event page: try the organizer's own site layout.
            from ..contact_discovery import discover_contact_urls
            widened = await discover_contact_urls(row["organizer_website"] or row["hackathon_url"])
            if widened:
                inserted += await _fetch_and_store_contacts(conn, str(row["id"]), widened, limit=4)
        if inserted == before:
            provider_inserted, _used = await _provider_fallback(
                conn, str(row["id"]), website_url=row["organizer_website"] or row["hackathon_url"]
            )
            inserted += provider_inserted
        if inserted > before:
            from ..verification import verify_contact_emails

            try:
                await verify_contact_emails(conn, "hackathons", str(row["id"]))
            except Exception as e:  # noqa: BLE001 - verification never blocks a sweep
                logger.debug("hackathon contact verification failed: %s", e)
            await recompute_hackathon_quality(conn, str(row["id"]))
            enriched += 1
    return {"processed": processed, "enriched": enriched, "contacts_inserted": inserted}


async def enrich_hackathon_by_id(conn, hackathon_id: str, *, fetch_pages: bool = True) -> dict[str, Any]:
    """Enrich exactly one hackathon (used by the per-row UI action)."""
    row = await conn.fetchrow(
        """SELECT id, hackathon_url, registration_url, organizer_website, source_url
             FROM hackathons WHERE id=$1""",
        hackathon_id,
    )
    if not row:
        return {"status": "not_found"}
    inserted = 0
    providers_used: list[str] = []
    if fetch_pages:
        urls = [u for u in (row["hackathon_url"], row["organizer_website"], row["source_url"]) if u]
        inserted += await _fetch_and_store_contacts(conn, hackathon_id, urls, limit=3)
        if inserted == 0:
            # Widen to the organizer's own site (sitemap + role links).
            from ..contact_discovery import discover_contact_urls
            widened = await discover_contact_urls(row["organizer_website"] or row["hackathon_url"])
            if widened:
                inserted += await _fetch_and_store_contacts(conn, hackathon_id, widened, limit=4)
        if inserted == 0:
            provider_inserted, providers_used = await _provider_fallback(
                conn, hackathon_id, website_url=row["organizer_website"] or row["hackathon_url"]
            )
            inserted += provider_inserted
    # Verify what we found before anyone tries to send to it.
    verification_stats: dict[str, Any] = {}
    if inserted:
        from ..verification import verify_contact_emails

        verification_stats = await verify_contact_emails(conn, "hackathons", hackathon_id)
    quality = await recompute_hackathon_quality(conn, hackathon_id)
    return {"status": "completed", "contacts_inserted": inserted,
            "providers_used": providers_used, "verification": verification_stats, **quality}


async def run_hackathon_pipeline(db_pool, run_id: Optional[str], *, fetch_pages: bool = True) -> dict[str, Any]:
    """Post-discovery stage: normalize raw -> enrich -> predict -> snapshot EDA."""
    from .eda import snapshot_hackathon_eda
    from .normalizer import process_pending_raw
    from .prediction import generate_hackathon_predictions

    result: dict[str, Any] = {}
    if db_pool is None:
        return {"error": "no_database"}
    async with db_pool.acquire() as conn:
        result["normalize"] = await process_pending_raw(conn, "hackathons")
        result["enrich"] = await enrich_hackathon_contacts(conn, fetch_pages=fetch_pages)
        # Records that still have no reachable contact are re-queued automatically
        # (bounded, and rate-limited per entity) rather than waiting for a human.
        from ..reenrich import run_reenrichment_sweep
        result["reenrich"] = await run_reenrichment_sweep(
            conn, "hackathons", limit=REENRICH_LIMIT, fetch_pages=fetch_pages, enrich_one=enrich_hackathon_by_id
        )
        result["prediction"] = await generate_hackathon_predictions(conn, run_id=run_id)
        try:
            result["eda"] = await snapshot_hackathon_eda(conn)
        except Exception as e:  # noqa: BLE001
            logger.warning("hackathon EDA snapshot failed: %s", e)
            result["eda_error"] = str(e)[:200]
    return result
