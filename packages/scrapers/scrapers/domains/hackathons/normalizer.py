"""Hackathon normalization: raw -> canonical entity + historical occurrences.

Pipeline position:

    adapter.discover() -> raw_discovery_records -> [here] -> hackathons /
    hackathon_occurrences / hackathon_sources / hackathon_contacts

Entity resolution happens here, not in the adapter: the same event found on two
platforms must land on one canonical row (fingerprint first, fuzzy signals
second), and historical editions must be preserved as separate occurrences rather
than overwritten.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from ..entity_resolution import (
    fingerprint_hackathon,
    same_hackathon,
    slug_for,
)
from ..normalize import (
    as_list,
    clean_text,
    extract_domain,
    parse_bool,
    parse_date,
    parse_datetime,
    parse_money,
    slugify,
    strip_html,
)
from ..quality import (
    completeness_score,
    confidence_score,
    freshness_category,
    priority_for_role,
    quality_state,
    verification_score,
)

logger = logging.getLogger(__name__)

VALID_STATUS = {
    "DISCOVERED", "CONFIRMED", "ANNOUNCED", "REGISTRATION_OPEN", "UPCOMING",
    "HISTORICAL", "RECURRING_PATTERN", "PREDICTED", "LOW_CONFIDENCE_PREDICTION",
}

# Fields a newer scrape may fill on an existing row. Identity/ownership columns
# are deliberately absent: a scrape must never reassign a claimed lead.
MERGEABLE_FIELDS = (
    "organizer_name", "organizer_type", "organization_description", "organizer_website",
    "registration_url", "source_url", "source_platform",
    "event_type", "hackathon_type", "mode", "venue", "city", "state", "country", "timezone",
    "registration_start", "registration_deadline", "event_start", "event_end", "result_date",
    "team_size_min", "team_size_max", "eligibility", "student_only", "college_only",
    "open_to_public", "age_limit", "experience_requirement",
    "technology", "domain", "tracks", "problem_statements", "themes", "tags",
    "required_skills", "preferred_skills",
    "prize_pool", "first_prize", "second_prize", "third_prize", "sponsor_prizes",
    "internship_opportunities", "hiring_opportunities", "certificates", "mentorship",
    "judging_criteria",
    "organizer_email", "organizer_phone", "organizer_linkedin", "organizer_instagram",
    "organizer_x", "organizer_facebook", "organizer_discord", "organizer_community",
    "organizer_contact_name", "organizer_contact_designation",
)

# Fields a source may NOT overwrite once a nicer value exists.
PROTECTED_WHEN_SET = {"hackathon_url", "registration_url", "organizer_website"}


def derive_status(raw: dict[str, Any], now: Optional[datetime] = None) -> str:
    """Resolve the lifecycle label from dates, or the source's own claim.

    Predicted labels are never derived here — only the prediction engine assigns
    those — so a scrape can never accidentally publish a guess as confirmed.
    """
    ref = now or datetime.now(timezone.utc)
    explicit = clean_text(raw.get("status")).upper()
    end = parse_datetime(raw.get("event_end"))
    start = parse_datetime(raw.get("event_start"))
    reg_end = parse_datetime(raw.get("registration_deadline"))
    if end and end < ref:
        return "HISTORICAL"
    if explicit in VALID_STATUS:
        # A source may claim REGISTRATION_OPEN etc., but never that something is
        # CONFIRMED unless it gave real dates.
        if explicit in ("CONFIRMED",) and not (start or reg_end):
            return "ANNOUNCED"
        if explicit in ("PREDICTED", "LOW_CONFIDENCE_PREDICTION", "RECURRING_PATTERN"):
            return "ANNOUNCED"
        return explicit
    if reg_end and reg_end >= ref:
        return "REGISTRATION_OPEN"
    if start and start >= ref:
        return "UPCOMING"
    if start or reg_end:
        return "ANNOUNCED"
    return "DISCOVERED"


def derive_mode(raw: dict[str, Any]) -> Optional[str]:
    mode = clean_text(raw.get("mode")).lower()
    if mode in ("online", "offline", "hybrid"):
        return mode
    kind = clean_text(raw.get("hackathon_type") or raw.get("event_type")).lower()
    text = f"{kind} {clean_text(raw.get('venue'))} {clean_text(raw.get('eligibility'), 300)}".lower()
    if "virtual" in text or "online" in text:
        return "online"
    if "hybrid" in text:
        return "hybrid"
    if clean_text(raw.get("city")) or clean_text(raw.get("venue")):
        return "offline"
    return None


def normalize_hackathon(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Map any adapter's raw payload to canonical hackathon columns."""
    name = clean_text(raw.get("name") or raw.get("title"))
    if not name:
        return None
    url = clean_text(raw.get("hackathon_url") or raw.get("url") or raw.get("source_url")) or None
    organizer = clean_text(raw.get("organizer_name") or raw.get("organization_name"))
    status = derive_status(raw)
    mode = derive_mode(raw)
    themes = as_list(raw.get("themes"))
    technology = clean_text(raw.get("technology")) or (", ".join(themes[:3]) if themes else None)
    email = clean_text(raw.get("organizer_email") or raw.get("contact_email")) or None
    if email and "@" not in email:
        email = None

    normalized: dict[str, Any] = {
        "name": name,
        "slug": slug_for(name, url),
        "organizer_name": organizer or None,
        "organizer_type": clean_text(raw.get("organizer_type")) or None,
        "organization_description": strip_html(raw.get("organization_description"), 2000) or None,
        "organizer_website": clean_text(raw.get("organizer_website")) or None,
        "hackathon_url": url,
        "registration_url": clean_text(raw.get("registration_url")) or None,
        "source_url": clean_text(raw.get("source_url")) or url,
        "source_platform": clean_text(raw.get("source_platform")) or (extract_domain(url) if url else None),
        "event_type": clean_text(raw.get("event_type")) or "hackathon",
        "hackathon_type": clean_text(raw.get("hackathon_type")) or None,
        "mode": mode,
        "venue": clean_text(raw.get("venue")) or None,
        "city": clean_text(raw.get("city")) or None,
        "state": clean_text(raw.get("state")) or None,
        "country": clean_text(raw.get("country")) or None,
        "timezone": clean_text(raw.get("timezone")) or None,
        "registration_start": parse_datetime(raw.get("registration_start")),
        "registration_deadline": parse_datetime(raw.get("registration_deadline")),
        "event_start": parse_datetime(raw.get("event_start")),
        "event_end": parse_datetime(raw.get("event_end")),
        "result_date": parse_datetime(raw.get("result_date")),
        "team_size_min": _int_or_none(raw.get("team_size_min")),
        "team_size_max": _int_or_none(raw.get("team_size_max")),
        "eligibility": clean_text(raw.get("eligibility"), 1000) or None,
        "student_only": parse_bool(raw.get("student_only")),
        "college_only": parse_bool(raw.get("college_only")),
        "open_to_public": parse_bool(raw.get("open_to_public")),
        "age_limit": clean_text(raw.get("age_limit")) or None,
        "experience_requirement": clean_text(raw.get("experience_requirement")) or None,
        "technology": technology,
        "domain": clean_text(raw.get("domain")) or None,
        "tracks": as_list(raw.get("tracks")),
        "problem_statements": as_list(raw.get("problem_statements")),
        "themes": themes,
        "tags": as_list(raw.get("tags")),
        "required_skills": as_list(raw.get("required_skills")),
        "preferred_skills": as_list(raw.get("preferred_skills")),
        "prize_pool": parse_money(raw.get("prize_pool")) if raw.get("prize_pool") not in (None, "") else None,
        "first_prize": parse_money(raw.get("first_prize")) if raw.get("first_prize") not in (None, "") else None,
        "second_prize": parse_money(raw.get("second_prize")) if raw.get("second_prize") not in (None, "") else None,
        "third_prize": parse_money(raw.get("third_prize")) if raw.get("third_prize") not in (None, "") else None,
        "sponsor_prizes": as_list(raw.get("sponsor_prizes")),
        "internship_opportunities": parse_bool(raw.get("internship_opportunities")),
        "hiring_opportunities": parse_bool(raw.get("hiring_opportunities")),
        "certificates": parse_bool(raw.get("certificates")),
        "mentorship": parse_bool(raw.get("mentorship")),
        "judging_criteria": clean_text(raw.get("judging_criteria"), 2000) or None,
        "organizer_email": email,
        "organizer_phone": clean_text(raw.get("organizer_phone")) or None,
        "organizer_linkedin": clean_text(raw.get("organizer_linkedin")) or None,
        "organizer_instagram": clean_text(raw.get("organizer_instagram")) or None,
        "organizer_x": clean_text(raw.get("organizer_x")) or None,
        "organizer_facebook": clean_text(raw.get("organizer_facebook")) or None,
        "organizer_discord": clean_text(raw.get("organizer_discord")) or None,
        "organizer_community": clean_text(raw.get("organizer_community")) or None,
        "organizer_contact_name": clean_text(raw.get("organizer_contact_name")) or None,
        "organizer_contact_designation": clean_text(raw.get("organizer_contact_designation")) or None,
        "status": status,
        "historical_occurrence": status == "HISTORICAL",
        "raw_payload": raw.get("raw_payload") or raw,
    }
    normalized["fingerprint"] = fingerprint_hackathon(
        normalized["name"], normalized.get("organizer_name"), normalized.get("hackathon_url")
    )
    # Quality signals available before contacts are attached.
    completeness, _ = completeness_score("hackathons", normalized)
    normalized["completeness_score"] = completeness
    normalized["freshness_category"] = freshness_category("hackathons", normalized)
    normalized["verification_status"] = normalized.get("verification_status") or "unverified"
    normalized["confidence_score"] = confidence_score("hackathons", normalized)
    normalized["enrichment_status"] = "ENRICHING" if (email or normalized.get("organizer_phone")) else "NORMALIZED"
    normalized["outreach_readiness"] = (
        "PARTIALLY_ENRICHED" if (email or normalized.get("organizer_phone")) else "NEEDS_ENRICHMENT"
    )
    return normalized


def _int_or_none(value: Any) -> Optional[int]:
    try:
        result = int(str(value).strip())
        return result if result > 0 else None
    except (TypeError, ValueError):
        return None


def contact_rows_for(normalized: dict[str, Any]) -> list[dict[str, Any]]:
    """Contacts carried in the raw payload. Only real locators, never a bare name."""
    person = clean_text(normalized.get("organizer_contact_name"))
    email = clean_text(normalized.get("organizer_email"))
    phone = clean_text(normalized.get("organizer_phone"))
    linkedin = clean_text(normalized.get("organizer_linkedin"))
    if not (email or phone or linkedin):
        return []
    role = "organizer" if (person or email) else "organizer"
    return [{
        "full_name": person or None,
        "designation": clean_text(normalized.get("organizer_contact_designation")) or None,
        "role_category": role,
        "email": email or None,
        "phone": phone or None,
        "linkedin_url": linkedin or None,
        "priority": priority_for_role("hackathons", role),
        "contact_source": normalized.get("source_platform") or "discovery",
        "source_url": normalized.get("source_url"),
        "verification_status": "unverified",
        "confidence_score": 55 if email else 40,
    }]


def _merge(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """Fill gaps and refresh, but never downgrade a protected/verified value."""
    merged = dict(existing)
    for field in MERGEABLE_FIELDS:
        new = incoming.get(field)
        if new in (None, "", [], {}):
            continue
        old = merged.get(field)
        if field in PROTECTED_WHEN_SET and old not in (None, "", [], {}):
            continue
        # Scalar overwrite: a fresher scrape wins. Lists merge uniquely so an
        # earlier source's tags are not lost.
        if isinstance(old, list) and isinstance(new, list):
            seen = list(old)
            for item in new:
                if item not in seen:
                    seen.append(item)
            merged[field] = seen
        else:
            merged[field] = new
    return merged


async def upsert_hackathon(conn, normalized: dict[str, Any], run_id: Optional[str] = None) -> tuple[Optional[str], bool, bool]:
    """Insert or merge one canonical hackathon.

    Returns (hackathon_id, inserted, was_duplicate). Resume-safe: called inside a
    transaction per raw record so a crash never leaves a half-written entity.
    """
    fingerprint = normalized["fingerprint"]
    # 1. Exact fingerprint.
    existing = await conn.fetchrow(
        "SELECT * FROM hackathons WHERE fingerprint = $1", fingerprint
    )
    # 2. Fuzzy match against same-name-key candidates (cross-source spelling).
    if existing is None:
        candidates = await conn.fetch(
            "SELECT * FROM hackathons WHERE slug = $1 LIMIT 5", normalized.get("slug") or ""
        )
        for cand in candidates:
            is_same, _conf, _sig = same_hackathon(dict(cand), normalized)
            if is_same:
                existing = cand
                break

    if existing is None:
        hid = await conn.fetchval(
            """
            INSERT INTO hackathons (
              name, slug, organizer_name, organizer_type, organization_description,
              organizer_website, hackathon_url, registration_url, source_url, source_platform,
              event_type, hackathon_type, mode, venue, city, state, country, timezone,
              registration_start, registration_deadline, event_start, event_end, result_date,
              team_size_min, team_size_max, eligibility, student_only, college_only,
              open_to_public, age_limit, experience_requirement,
              technology, domain, tracks, problem_statements, themes, tags,
              required_skills, preferred_skills,
              prize_pool, first_prize, second_prize, third_prize, sponsor_prizes,
              internship_opportunities, hiring_opportunities, certificates, mentorship,
              judging_criteria,
              organizer_email, organizer_phone, organizer_linkedin, organizer_instagram,
              organizer_x, organizer_facebook, organizer_discord, organizer_community,
              organizer_contact_name, organizer_contact_designation,
              contact_name, contact_designation, contact_email, contact_phone, contact_linkedin,
              contact_source, outreach_priority, outreach_status,
              verification_status, source_count, source_urls,
              status, historical_occurrence,
              completeness_score, freshness_category, enrichment_status, outreach_readiness,
              fingerprint, raw_payload
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,
              $19,$20,$21,$22,$23,
              $24,$25,$26,$27,$28,
              $29,$30,$31,
              $32,$33,$34::jsonb,$35::jsonb,$36::jsonb,$37::jsonb,
              $38::jsonb,$39::jsonb,
              $40,$41,$42,$43,$44::jsonb,
              $45,$46,$47,$48,
              $49,
              $50,$51,$52,$53,
              $54,$55,$56,$57,
              $58,$59,
              $60,$61,$62,$63,$64,
              $65,$66,$67,
              $68,$69,$70::jsonb,
              $71,$72,
              $73,$74,$75,$76,
              $77,$78::jsonb
            ) RETURNING id
            """,
            normalized["name"], normalized["slug"], normalized.get("organizer_name"),
            normalized.get("organizer_type"), normalized.get("organization_description"),
            normalized.get("organizer_website"), normalized.get("hackathon_url"),
            normalized.get("registration_url"), normalized.get("source_url"),
            normalized.get("source_platform"),
            normalized.get("event_type"), normalized.get("hackathon_type"),
            normalized.get("mode"), normalized.get("venue"), normalized.get("city"),
            normalized.get("state"), normalized.get("country"), normalized.get("timezone"),
            normalized.get("registration_start"), normalized.get("registration_deadline"),
            normalized.get("event_start"), normalized.get("event_end"), normalized.get("result_date"),
            normalized.get("team_size_min"), normalized.get("team_size_max"),
            normalized.get("eligibility"), normalized.get("student_only"),
            normalized.get("college_only"), normalized.get("open_to_public"),
            normalized.get("age_limit"), normalized.get("experience_requirement"),
            normalized.get("technology"), normalized.get("domain"),
            json.dumps(normalized.get("tracks") or []),
            json.dumps(normalized.get("problem_statements") or []),
            json.dumps(normalized.get("themes") or []), json.dumps(normalized.get("tags") or []),
            json.dumps(normalized.get("required_skills") or []),
            json.dumps(normalized.get("preferred_skills") or []),
            normalized.get("prize_pool"), normalized.get("first_prize"),
            normalized.get("second_prize"), normalized.get("third_prize"),
            json.dumps(normalized.get("sponsor_prizes") or []),
            normalized.get("internship_opportunities"), normalized.get("hiring_opportunities"),
            normalized.get("certificates"), normalized.get("mentorship"),
            normalized.get("judging_criteria"),
            normalized.get("organizer_email"), normalized.get("organizer_phone"),
            normalized.get("organizer_linkedin"), normalized.get("organizer_instagram"),
            normalized.get("organizer_x"), normalized.get("organizer_facebook"),
            normalized.get("organizer_discord"), normalized.get("organizer_community"),
            normalized.get("organizer_contact_name"), normalized.get("organizer_contact_designation"),
            normalized.get("organizer_contact_name"), normalized.get("organizer_contact_designation"),
            normalized.get("organizer_email"), normalized.get("organizer_phone"),
            normalized.get("organizer_linkedin"),
            normalized.get("source_platform"), "P1", "not_started",
            "unverified", 1, json.dumps([normalized.get("source_url")] if normalized.get("source_url") else []),
            normalized.get("status"), normalized.get("historical_occurrence", False),
            normalized.get("completeness_score"), normalized.get("freshness_category"),
            normalized.get("enrichment_status"), normalized.get("outreach_readiness"),
            fingerprint, json.dumps(normalized.get("raw_payload") or {}, default=str),
        )
        await _record_source(conn, hid, normalized)
        await _record_occurrence(conn, hid, normalized)
        await _record_contacts(conn, hid, normalized)
        return str(hid), True, False

    # Existing row: merge without downgrading, and bump provenance.
    hid = str(existing["id"])
    merged = _merge(dict(existing), normalized)
    source_count = int(existing.get("source_count") or 0) + 1
    source_urls = list(existing.get("source_urls") or [])
    if normalized.get("source_url") and normalized["source_url"] not in source_urls:
        source_urls.append(normalized["source_url"])
    merged["source_count"] = source_count
    merged["source_urls"] = source_urls
    # Status only advances forward; a stale scrape cannot un-HISTORICAL an event.
    status = _advance_status(str(existing.get("status")), str(normalized.get("status")))
    completeness, _ = completeness_score("hackathons", merged)
    verification = verification_score(merged)
    merged.update({
        "completeness_score": completeness,
        "verification_score": verification,
        "confidence_score": confidence_score("hackathons", merged),
        "freshness_category": freshness_category("hackathons", merged),
        "status": status,
    })
    await conn.execute(
        """
        UPDATE hackathons SET
          organizer_name=$2, organizer_type=$3, organization_description=$4, organizer_website=$5,
          registration_url=$6, source_url=$7, source_platform=$8,
          event_type=$9, hackathon_type=$10, mode=$11, venue=$12, city=$13, state=$14,
          country=$15, timezone=$16,
          registration_start=$17, registration_deadline=$18, event_start=$19, event_end=$20,
          result_date=$21, team_size_min=$22, team_size_max=$23, eligibility=$24,
          student_only=$25, college_only=$26, open_to_public=$27, age_limit=$28,
          experience_requirement=$29, technology=$30, domain=$31,
          tracks=$32::jsonb, problem_statements=$33::jsonb, themes=$34::jsonb, tags=$35::jsonb,
          required_skills=$36::jsonb, preferred_skills=$37::jsonb,
          prize_pool=$38, first_prize=$39, second_prize=$40, third_prize=$41,
          sponsor_prizes=$42::jsonb, internship_opportunities=$43, hiring_opportunities=$44,
          certificates=$45, mentorship=$46, judging_criteria=$47,
          organizer_email=$48, organizer_phone=$49, organizer_linkedin=$50,
          organizer_instagram=$51, organizer_x=$52, organizer_facebook=$53,
          organizer_discord=$54, organizer_community=$55,
          organizer_contact_name=$56, organizer_contact_designation=$57,
          status=$58, historical_occurrence=$59,
          source_count=$60, source_urls=$61::jsonb,
          completeness_score=$62, freshness_category=$63, confidence_score=$64,
          enrichment_status=$65, outreach_readiness=$66,
          last_seen_at=NOW(), updated_at=NOW()
        WHERE id=$1
        """,
        hid,
        merged.get("organizer_name"), merged.get("organizer_type"), merged.get("organization_description"),
        merged.get("organizer_website"), merged.get("registration_url"), merged.get("source_url"),
        merged.get("source_platform"), merged.get("event_type"), merged.get("hackathon_type"),
        merged.get("mode"), merged.get("venue"), merged.get("city"), merged.get("state"),
        merged.get("country"), merged.get("timezone"),
        merged.get("registration_start"), merged.get("registration_deadline"),
        merged.get("event_start"), merged.get("event_end"), merged.get("result_date"),
        merged.get("team_size_min"), merged.get("team_size_max"), merged.get("eligibility"),
        merged.get("student_only"), merged.get("college_only"), merged.get("open_to_public"),
        merged.get("age_limit"), merged.get("experience_requirement"), merged.get("technology"),
        merged.get("domain"),
        json.dumps(merged.get("tracks") or []), json.dumps(merged.get("problem_statements") or []),
        json.dumps(merged.get("themes") or []), json.dumps(merged.get("tags") or []),
        json.dumps(merged.get("required_skills") or []), json.dumps(merged.get("preferred_skills") or []),
        merged.get("prize_pool"), merged.get("first_prize"), merged.get("second_prize"),
        merged.get("third_prize"), json.dumps(merged.get("sponsor_prizes") or []),
        merged.get("internship_opportunities"), merged.get("hiring_opportunities"),
        merged.get("certificates"), merged.get("mentorship"), merged.get("judging_criteria"),
        merged.get("organizer_email"), merged.get("organizer_phone"), merged.get("organizer_linkedin"),
        merged.get("organizer_instagram"), merged.get("organizer_x"), merged.get("organizer_facebook"),
        merged.get("organizer_discord"), merged.get("organizer_community"),
        merged.get("organizer_contact_name"), merged.get("organizer_contact_designation"),
        status, merged.get("historical_occurrence", False),
        source_count, json.dumps(source_urls),
        completeness, merged.get("freshness_category"), merged.get("confidence_score"),
        merged.get("enrichment_status"), merged.get("outreach_readiness"),
    )
    await _record_source(conn, hid, normalized)
    await _record_occurrence(conn, hid, normalized)
    await _record_contacts(conn, hid, merged)
    return hid, False, True


_STATUS_RANK = {
    "DISCOVERED": 0, "ANNOUNCED": 1, "CONFIRMED": 2, "UPCOMING": 3,
    "REGISTRATION_OPEN": 4, "HISTORICAL": 5,
    "RECURRING_PATTERN": 6, "PREDICTED": 7, "LOW_CONFIDENCE_PREDICTION": 8,
}


def _advance_status(old: str, new: str) -> str:
    """Take the more informative of the two, except never regress out of
    HISTORICAL (a past edition stays past) and never let a scrape assign a
    prediction label."""
    if new in ("PREDICTED", "LOW_CONFIDENCE_PREDICTION", "RECURRING_PATTERN"):
        new = "ANNOUNCED"
    if old == "HISTORICAL" and new != "HISTORICAL":
        return old
    return new if _STATUS_RANK.get(new, 0) >= _STATUS_RANK.get(old, 0) else old


async def _record_source(conn, hackathon_id: str, normalized: dict[str, Any]) -> None:
    url = normalized.get("source_url")
    if not url:
        return
    try:
        await conn.execute(
            """
            INSERT INTO hackathon_sources
              (hackathon_id, source_platform, source_url, extraction_method, confidence, raw_payload)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb)
            ON CONFLICT (hackathon_id, source_url) DO NOTHING
            """,
            hackathon_id,
            normalized.get("source_platform") or "unknown",
            url,
            "adapter",
            normalized.get("confidence_score"),
            json.dumps({"status": normalized.get("status")}, default=str),
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("source record failed: %s", e)


async def _record_occurrence(conn, hackathon_id: str, normalized: dict[str, Any]) -> None:
    """Persist the edition (year) without ever overwriting history."""
    stamp = (
        parse_datetime(normalized.get("event_start"))
        or parse_datetime(normalized.get("event_end"))
        or parse_datetime(normalized.get("registration_deadline"))
        or parse_datetime(normalized.get("registration_start"))
    )
    year = stamp.year if stamp else _int_or_none(normalized.get("year"))
    if not year:
        return
    try:
        await conn.execute(
            """
            INSERT INTO hackathon_occurrences
              (hackathon_id, year, event_start, event_end, registration_start,
               registration_deadline, venue, city, state, mode, prize_pool,
               source_url, source_platform, is_confirmed)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (hackathon_id, year) DO UPDATE SET
              event_start = COALESCE(EXCLUDED.event_start, hackathon_occurrences.event_start),
              event_end = COALESCE(EXCLUDED.event_end, hackathon_occurrences.event_end),
              registration_start = COALESCE(EXCLUDED.registration_start, hackathon_occurrences.registration_start),
              registration_deadline = COALESCE(EXCLUDED.registration_deadline, hackathon_occurrences.registration_deadline),
              venue = COALESCE(EXCLUDED.venue, hackathon_occurrences.venue),
              city = COALESCE(EXCLUDED.city, hackathon_occurrences.city),
              state = COALESCE(EXCLUDED.state, hackathon_occurrences.state),
              mode = COALESCE(EXCLUDED.mode, hackathon_occurrences.mode),
              prize_pool = COALESCE(EXCLUDED.prize_pool, hackathon_occurrences.prize_pool),
              source_url = COALESCE(EXCLUDED.source_url, hackathon_occurrences.source_url),
              source_platform = COALESCE(EXCLUDED.source_platform, hackathon_occurrences.source_platform),
              is_confirmed = hackathon_occurrences.is_confirmed OR EXCLUDED.is_confirmed
            """,
            hackathon_id, year,
            parse_date(normalized.get("event_start")), parse_date(normalized.get("event_end")),
            parse_date(normalized.get("registration_start")), parse_date(normalized.get("registration_deadline")),
            normalized.get("venue"), normalized.get("city"), normalized.get("state"),
            normalized.get("mode"), normalized.get("prize_pool"),
            normalized.get("source_url"), normalized.get("source_platform"),
            normalized.get("status") in ("CONFIRMED", "REGISTRATION_OPEN", "UPCOMING", "HISTORICAL"),
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("occurrence record failed: %s", e)


async def _record_contacts(conn, hackathon_id: str, normalized: dict[str, Any]) -> int:
    created = 0
    for row in contact_rows_for(normalized):
        try:
            await conn.execute(
                """
                INSERT INTO hackathon_contacts
                  (hackathon_id, full_name, designation, role_category, email, phone,
                   linkedin_url, priority, contact_source, source_url, verification_status, confidence_score)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                """,
                hackathon_id, row["full_name"], row["designation"], row["role_category"],
                row["email"], row["phone"], row["linkedin_url"], row["priority"],
                row["contact_source"], row["source_url"], row["verification_status"],
                row["confidence_score"],
            )
            created += 1
        except Exception as e:  # noqa: BLE001
            logger.debug("contact record failed: %s", e)
    return created


async def process_raw_record(conn, raw_row: dict) -> dict[str, Any]:
    """Normalize one durable raw record. Idempotent; safe to re-run after a crash."""
    raw_id = raw_row["id"]
    payload = raw_row.get("payload")
    if isinstance(payload, str):
        payload = json.loads(payload)
    normalized = normalize_hackathon(payload or {})
    if normalized is None:
        await conn.execute(
            "UPDATE raw_discovery_records SET status='failed', error=$2, processed_at=NOW() WHERE id=$1",
            raw_id, "unparseable payload (no name)",
        )
        return {"status": "failed", "reason": "no_name"}
    try:
        async with conn.transaction():
            hid, inserted, _dup = await upsert_hackathon(conn, normalized, raw_row.get("run_id"))
            await conn.execute(
                "UPDATE raw_discovery_records SET status='processed', processed_at=NOW() WHERE id=$1",
                raw_id,
            )
        return {"status": "inserted" if inserted else "updated", "hackathon_id": hid}
    except Exception as e:  # noqa: BLE001
        logger.warning("raw %s normalize failed: %s", raw_id, e)
        await conn.execute(
            "UPDATE raw_discovery_records SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1",
            raw_id, str(e)[:500],
        )
        return {"status": "failed", "reason": str(e)[:200]}


async def process_pending_raw(conn, domain: str = "hackathons", limit: int = 500) -> dict[str, int]:
    """Drain durable raw records for a domain (crash recovery + normal path).

    Claims rows with FOR UPDATE SKIP LOCKED so two workers cannot double-process
    the same raw record.
    """
    counts = {"inserted": 0, "updated": 0, "failed": 0, "duplicates": 0}
    async with conn.transaction():
        rows = await conn.fetch(
            """
            SELECT * FROM raw_discovery_records
             WHERE domain=$1 AND status IN ('stored','failed') AND attempts < 5
             ORDER BY fetched_at ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
            """,
            domain, limit,
        )
        for row in rows:
            await conn.execute(
                "UPDATE raw_discovery_records SET status='processing' WHERE id=$1", row["id"]
            )
    for row in rows:
        result = await process_raw_record(conn, dict(row))
        status = result.get("status")
        if status in counts:
            counts[status] += 1
        else:
            counts["failed"] += 1
    return counts
