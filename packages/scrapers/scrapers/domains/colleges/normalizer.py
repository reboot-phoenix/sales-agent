"""College normalization: raw -> canonical institution + source provenance.

Entity resolution is strongest-key-first (AISHE code, then official domain, then
normalized name + state) because Indian college names are highly repetitive across
states, and collapsing them would corrupt the state-wise dataset.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from ..entity_resolution import fingerprint_college, same_college, slug_for
from ..normalize import (
    as_list,
    clean_text,
    extract_domain,
    parse_bool,
    strip_html,
)
from ..quality import (
    completeness_score,
    confidence_score,
    freshness_category,
    quality_state,
)

logger = logging.getLogger(__name__)

VALID_OWNERSHIP = {"government", "private", "aided", "autonomous", "public", "deemed"}

MERGEABLE_FIELDS = (
    "official_name", "aishe_code", "university_affiliation", "state", "district", "city", "address",
    "pincode", "institution_type", "ownership", "is_public", "autonomous",
    "accreditation", "naac_grade", "naac_score", "nirf_rank", "aicte_approved",
    "website_url", "official_email", "phone", "admissions_contact", "placement_contact",
    "linkedin_url", "socials", "programs",
)

PROTECTED_WHEN_SET = {"website_url", "official_email", "aishe_code"}


def _mentions(text: str, *needles: str) -> bool:
    """Whole-prefix match so 'unaided' is never read as 'aided'."""
    return any(re.search(rf"\b{re.escape(n)}", text) for n in needles)


def derive_ownership(raw: dict[str, Any]) -> Optional[str]:
    text = " ".join(clean_text(raw.get(k)) for k in ("ownership", "institution_type", "management", "name")).lower()
    if "autonomous" in text:
        return "autonomous"
    if _mentions(text, "government", "govt", "public"):
        return "government"
    if _mentions(text, "deemed"):
        return "deemed"
    # Checked before 'aided': 'Private Unaided' contains 'aided' as a substring.
    if _mentions(text, "private", "self-financ", "unaided"):
        return "private"
    if _mentions(text, "aided", "grant-in-aid"):
        return "aided"
    explicit = clean_text(raw.get("ownership")).lower()
    return explicit if explicit in VALID_OWNERSHIP else None


def derive_institution_type(raw: dict[str, Any]) -> Optional[str]:
    text = " ".join(clean_text(raw.get(k)) for k in ("institution_type", "name", "official_name")).lower()
    if _mentions(text, "deemed"):
        return "deemed_university"
    if "university" in text:
        return "university"
    if "institute" in text or "institution" in text:
        return "institute"
    if "college" in text:
        return "college"
    explicit = clean_text(raw.get("institution_type"))
    return explicit or None


def normalize_college(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    name = clean_text(raw.get("name") or raw.get("institution_name") or raw.get("college_name"))
    if not name:
        return None
    website = clean_text(raw.get("website_url") or raw.get("website") or raw.get("url"))
    if website and not website.startswith("http"):
        website = "https://" + website.lstrip("/")
    email = clean_text(raw.get("official_email") or raw.get("email"))
    if email and "@" not in email:
        email = None
    ownership = derive_ownership(raw)
    normalized: dict[str, Any] = {
        "name": name,
        "official_name": clean_text(raw.get("official_name")) or name,
        "slug": slug_for(name, clean_text(raw.get("state"))),
        "aishe_code": clean_text(raw.get("aishe_code")) or None,
        "university_affiliation": clean_text(raw.get("university_affiliation") or raw.get("university")),
        "state": clean_text(raw.get("state")) or None,
        "district": clean_text(raw.get("district")) or None,
        "city": clean_text(raw.get("city") or raw.get("location")) or None,
        "address": strip_html(raw.get("address"), 500) or None,
        "pincode": clean_text(raw.get("pincode") or raw.get("pin_code")) or None,
        "institution_type": derive_institution_type(raw),
        "ownership": ownership,
        "is_public": parse_bool(raw.get("is_public")) if raw.get("is_public") not in (None, "") else (
            ownership in ("government", "public") if ownership else None
        ),
        "autonomous": parse_bool(raw.get("autonomous")) if raw.get("autonomous") not in (None, "") else (
            ownership == "autonomous" if ownership else None
        ),
        "accreditation": clean_text(raw.get("accreditation")) or None,
        "naac_grade": clean_text(raw.get("naac_grade")) or None,
        "naac_score": _float_or_none(raw.get("naac_score")),
        "nirf_rank": _int_or_none(raw.get("nirf_rank") or raw.get("rank")),
        "aicte_approved": parse_bool(raw.get("aicte_approved")) if raw.get("aicte_approved") not in (None, "") else None,
        "website_url": website or None,
        "official_email": email,
        "phone": clean_text(raw.get("phone") or raw.get("contact")) or None,
        "admissions_contact": clean_text(raw.get("admissions_contact")) or None,
        "placement_contact": clean_text(raw.get("placement_contact")) or None,
        "linkedin_url": clean_text(raw.get("linkedin_url")) or None,
        "socials": raw.get("socials") if isinstance(raw.get("socials"), dict) else {},
        "programs": as_list(raw.get("programs")),
        "source_url": clean_text(raw.get("source_url")) or website,
        "source_name": clean_text(raw.get("source_name")) or (extract_domain(raw.get("source_url")) if raw.get("source_url") else None),
        "raw_payload": raw.get("raw_payload") or raw,
    }
    normalized["fingerprint"] = fingerprint_college(
        normalized["name"], normalized.get("state"), normalized.get("aishe_code"), normalized.get("website_url")
    )
    completeness, _ = completeness_score("colleges", normalized)
    normalized["completeness_score"] = completeness
    normalized["freshness_category"] = freshness_category("colleges", normalized)
    normalized["confidence_score"] = confidence_score("colleges", normalized)
    normalized["verification_status"] = "unverified"
    normalized["enrichment_status"] = "NORMALIZED"
    normalized["outreach_readiness"] = "NEEDS_ENRICHMENT"
    return normalized


def _int_or_none(value: Any) -> Optional[int]:
    try:
        result = int(str(value).strip().split()[0])
        return result if result > 0 else None
    except (TypeError, ValueError, IndexError):
        return None


def _float_or_none(value: Any) -> Optional[float]:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _merge(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for field in MERGEABLE_FIELDS:
        new = incoming.get(field)
        if new in (None, "", [], {}):
            continue
        old = merged.get(field)
        if field in PROTECTED_WHEN_SET and old not in (None, "", [], {}):
            continue
        if isinstance(old, list) and isinstance(new, list):
            seen = list(old)
            seen.extend(item for item in new if item not in seen)
            merged[field] = seen
        else:
            merged[field] = new
    return merged


async def upsert_college(conn, normalized: dict[str, Any], run_id: Optional[str] = None) -> tuple[Optional[str], bool]:
    """Insert or merge one canonical college. Returns (college_id, inserted)."""
    fingerprint = normalized["fingerprint"]
    existing = await conn.fetchrow("SELECT * FROM colleges WHERE fingerprint=$1", fingerprint)
    if existing is None and normalized.get("aishe_code"):
        existing = await conn.fetchrow(
            "SELECT * FROM colleges WHERE lower(aishe_code)=lower($1) LIMIT 1", normalized["aishe_code"]
        )
    if existing is None:
        candidates = await conn.fetch(
            "SELECT * FROM colleges WHERE lower(state)=lower($1) LIMIT 25",
            normalized.get("state") or "",
        )
        for cand in candidates:
            is_same, _conf, _signals = same_college(dict(cand), normalized)
            if is_same:
                existing = cand
                break

    if existing is None:
        cid = await conn.fetchval(
            """
            INSERT INTO colleges (
              name, official_name, slug, aishe_code, university_affiliation,
              state, district, city, address, pincode,
              institution_type, ownership, is_public, autonomous,
              accreditation, naac_grade, naac_score, nirf_rank, aicte_approved,
              website_url, official_email, phone, admissions_contact, placement_contact,
              linkedin_url, socials, programs,
              verification_status, source_count, source_urls,
              completeness_score, freshness_category, confidence_score,
              enrichment_status, outreach_readiness, fingerprint, raw_payload
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,$19,
              $20,$21,$22,$23,$24,$25,$26::jsonb,$27::jsonb,
              'unverified', 1, $28::jsonb,
              $29,$30,$31,$32,$33,$34,$35::jsonb
            ) RETURNING id
            """,
            normalized["name"], normalized.get("official_name"), normalized["slug"],
            normalized.get("aishe_code"), normalized.get("university_affiliation"),
            normalized.get("state"), normalized.get("district"), normalized.get("city"),
            normalized.get("address"), normalized.get("pincode"),
            normalized.get("institution_type"), normalized.get("ownership"),
            normalized.get("is_public"), normalized.get("autonomous"),
            normalized.get("accreditation"), normalized.get("naac_grade"),
            normalized.get("naac_score"), normalized.get("nirf_rank"), normalized.get("aicte_approved"),
            normalized.get("website_url"), normalized.get("official_email"),
            normalized.get("phone"), normalized.get("admissions_contact"),
            normalized.get("placement_contact"), normalized.get("linkedin_url"),
            json.dumps(normalized.get("socials") or {}), json.dumps(normalized.get("programs") or []),
            json.dumps([normalized.get("source_url")] if normalized.get("source_url") else []),
            normalized.get("completeness_score"), normalized.get("freshness_category"),
            normalized.get("confidence_score"), normalized.get("enrichment_status"),
            normalized.get("outreach_readiness"), fingerprint,
            json.dumps(normalized.get("raw_payload") or {}, default=str),
        )
        await _record_source(conn, cid, normalized)
        return str(cid), True

    cid = str(existing["id"])
    merged = _merge(dict(existing), normalized)
    source_count = int(existing.get("source_count") or 0) + 1
    source_urls = list(existing.get("source_urls") or [])
    if normalized.get("source_url") and normalized["source_url"] not in source_urls:
        source_urls.append(normalized["source_url"])
    completeness, _ = completeness_score("colleges", merged)
    await conn.execute(
        """
        UPDATE colleges SET
          official_name=$2, university_affiliation=$3, state=$4, district=$5, city=$6,
          address=$7, pincode=$8, institution_type=$9, ownership=$10, is_public=$11,
          autonomous=$12, accreditation=$13, naac_grade=$14, naac_score=$15,
          nirf_rank=$16, aicte_approved=$17, website_url=$18, official_email=$19,
          phone=$20, admissions_contact=$21, placement_contact=$22, linkedin_url=$23,
          socials=$24::jsonb, programs=$25::jsonb,
          aishe_code=COALESCE(aishe_code,$26), source_count=$27, source_urls=$28::jsonb,
          completeness_score=$29, freshness_category=$30, confidence_score=$31,
          updated_at=NOW(), last_seen_at=NOW()
        WHERE id=$1
        """,
        cid,
        merged.get("official_name"), merged.get("university_affiliation"),
        merged.get("state"), merged.get("district"), merged.get("city"),
        merged.get("address"), merged.get("pincode"), merged.get("institution_type"),
        merged.get("ownership"), merged.get("is_public"), merged.get("autonomous"),
        merged.get("accreditation"), merged.get("naac_grade"), merged.get("naac_score"),
        merged.get("nirf_rank"), merged.get("aicte_approved"), merged.get("website_url"),
        merged.get("official_email"), merged.get("phone"), merged.get("admissions_contact"),
        merged.get("placement_contact"), merged.get("linkedin_url"),
        json.dumps(merged.get("socials") or {}), json.dumps(merged.get("programs") or []),
        normalized.get("aishe_code"), source_count, json.dumps(source_urls),
        completeness, freshness_category("colleges", merged), confidence_score("colleges", merged),
    )
    await _record_source(conn, cid, normalized)
    return cid, False


async def _record_source(conn, college_id: str, normalized: dict[str, Any]) -> None:
    url = normalized.get("source_url")
    if not url:
        return
    try:
        await conn.execute(
            """
            INSERT INTO college_sources (college_id, source_name, source_url, extraction_method, confidence, raw_payload)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb)
            ON CONFLICT (college_id, source_url) DO NOTHING
            """,
            college_id, normalized.get("source_name") or "unknown", url, "adapter",
            normalized.get("confidence_score"), json.dumps({"source": normalized.get("source_name")}),
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("college source record failed: %s", e)


async def process_raw_record(conn, raw_row: dict) -> dict[str, Any]:
    raw_id = raw_row["id"]
    payload = raw_row.get("payload")
    if isinstance(payload, str):
        payload = json.loads(payload)
    normalized = normalize_college(payload or {})
    if normalized is None:
        await conn.execute(
            "UPDATE raw_discovery_records SET status='failed', error=$2, processed_at=NOW() WHERE id=$1",
            raw_id, "unparseable payload (no name)",
        )
        return {"status": "failed", "reason": "no_name"}
    try:
        async with conn.transaction():
            cid, inserted = await upsert_college(conn, normalized, raw_row.get("run_id"))
            await conn.execute(
                "UPDATE raw_discovery_records SET status='processed', processed_at=NOW() WHERE id=$1", raw_id
            )
        return {"status": "inserted" if inserted else "updated", "college_id": cid}
    except Exception as e:  # noqa: BLE001
        logger.warning("college raw %s normalize failed: %s", raw_id, e)
        await conn.execute(
            "UPDATE raw_discovery_records SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1",
            raw_id, str(e)[:500],
        )
        return {"status": "failed", "reason": str(e)[:200]}


async def process_pending_raw(conn, domain: str = "colleges", limit: int = 500) -> dict[str, int]:
    counts = {"inserted": 0, "updated": 0, "failed": 0}
    async with conn.transaction():
        rows = await conn.fetch(
            """
            SELECT * FROM raw_discovery_records
             WHERE domain=$1 AND status IN ('stored','failed') AND attempts < 5
             ORDER BY fetched_at ASC LIMIT $2
             FOR UPDATE SKIP LOCKED
            """,
            domain, limit,
        )
        for row in rows:
            await conn.execute("UPDATE raw_discovery_records SET status='processing' WHERE id=$1", row["id"])
    for row in rows:
        result = await process_raw_record(conn, dict(row))
        counts[result.get("status", "failed")] = counts.get(result.get("status", "failed"), 0) + 1
    return counts
