"""Unified outreach readiness across all three lead domains.

The point of the platform is sending. That makes two questions the only ones that
matter for prioritisation:

1. **Can we reach someone here?** — a real locator (email/phone/LinkedIn) on a
   contact whose verification state we can stand behind.
2. **How valuable is it to reach them?** — domain-specific signal: a live
   hackathon registration window, a fresher job posted days ago, a large
   placement cell ahead of the season.

This module answers both with one deterministic score so the API, the workers and
the UI all rank leads the same way. It is pure computation over rows that already
exist — it never fetches, never guesses a missing field, and never turns an
unverified locator into a ready one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

DOMAINS = ("jobs", "hackathons", "colleges")

# Which locator we would actually use first, and what it is worth. A named person
# beats a shared mailbox; a phone call beats a LinkedIn DM only because it is
# faster to act on, so they score the same.
LOCATOR_WEIGHTS: dict[str, int] = {
    "verified_person_email": 40,
    "verified_role_email": 30,
    "verified_phone": 30,
    "unverified_email": 12,
    "unverified_phone": 10,
    "linkedin": 15,
}

# Roles worth reaching, by domain, highest first. Mirrors the contact priorities
# already used by the college/hackathon contact models.
ROLE_WEIGHTS: dict[str, dict[str, int]] = {
    "colleges": {"tpo": 30, "placement_head": 28, "placement_cell": 22,
                 "director": 18, "principal": 16, "dean": 12, "hod": 10,
                 "official": 8, "faculty": 6, "other": 4},
    "hackathons": {"organizer": 30, "outreach": 26, "sponsor": 18, "judge": 8},
    "jobs": {"hr": 30, "recruiter": 26, "hiring_manager": 22, "other": 6},
}

VERIFIED_STATES = ("verified", "cross_verified")

READINESS_ORDER = (
    "OUTREACH_READY",
    "PARTIALLY_ENRICHED",
    "NEEDS_ENRICHMENT",
    "INSUFFICIENT_DATA",
)


@dataclass
class OutreachAssessment:
    """One lead's outreach position, with the reasons behind the number."""

    domain: str
    entity_id: str
    name: str = ""
    score: int = 0                     # 0-100
    priority: str = "P4"               # P0..P4
    readiness: str = "INSUFFICIENT_DATA"
    best_contact: Optional[dict[str, Any]] = None
    reasons: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "entity_id": self.entity_id,
            "name": self.name,
            "score": self.score,
            "priority": self.priority,
            "readiness": self.readiness,
            "best_contact": self.best_contact,
            "reasons": list(self.reasons),
            "blockers": list(self.blockers),
        }


# ---------------------------------------------------------------- scoring ----


def phone_worth_sending(phone: Optional[str]) -> bool:
    """Structurally usable phone: enough digits, no all-same-digit placeholder."""
    if not phone:
        return False
    digits = "".join(ch for ch in str(phone) if ch.isdigit())
    if len(digits) < 10 or len(digits) > 15:
        return False
    return len(set(digits)) > 3


def contact_locator_score(contact: dict[str, Any]) -> tuple[int, list[str]]:
    """Score one contact row by what it gives us and how much we trust it."""
    status = str(contact.get("verification_status") or "unverified").lower()
    verified = status in VERIFIED_STATES
    # An explicitly dead locator is worth nothing: counting it would inflate a
    # lead that no rep can actually act on.
    dead = status in ("failed", "undeliverable", "invalid", "bounced")
    reasons: list[str] = []
    score = 0
    if dead:
        return 0, ["locator failed verification - not usable for outreach"]

    email = (contact.get("email") or contact.get("personal_email") or "").strip()
    phone = (contact.get("phone") or contact.get("personal_mobile") or "").strip()
    linkedin = (contact.get("linkedin_url") or "").strip()

    role_addr = False
    if email:
        from .email_verify import is_role_address

        role_addr = is_role_address(email)
    if email and verified:
        key = "verified_role_email" if role_addr else "verified_person_email"
        score += LOCATOR_WEIGHTS[key]
        reasons.append("verified role mailbox" if role_addr else "verified personal email")
    elif email:
        score += LOCATOR_WEIGHTS["unverified_email"]
        reasons.append("unverified email (discovered, not deliverability-checked)")
    if phone and verified and phone_worth_sending(phone):
        score += LOCATOR_WEIGHTS["verified_phone"]
        reasons.append("verified phone")
    elif phone and phone_worth_sending(phone):
        score += LOCATOR_WEIGHTS["unverified_phone"]
        reasons.append("unverified phone")
    if linkedin:
        score += LOCATOR_WEIGHTS["linkedin"]
        reasons.append("public LinkedIn profile")

    grade = (contact.get("verification_grade") or "").upper()[:1]
    if grade == "A":
        score += 6
    elif grade == "B":
        score += 3
    return score, reasons


def best_contact(contacts: Iterable[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The single contact we would put in front of a rep, or None."""
    best: Optional[dict[str, Any]] = None
    best_score = 0
    for contact in contacts:
        score, _ = contact_locator_score(contact)
        if score > best_score:
            best, best_score = contact, score
    return best


# Job contacts carry a job title rather than a role_category, so the published
# title is classified with keyword evidence. It is a label on real data, not a
# guess about a person.
_JOB_TITLE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("recruiter", ("recruit", "talent acquisition", "sourcer", "staffing")),
    ("hr", ("hr ", "hr/", "human resource", "people ops", "people partner",
            "hr business", "chief people", "chro")),
    ("hiring_manager", ("hiring manager", "engineering manager", "head of",
                        "director", "vp ", "vice president", "founder", "cto",
                        "ceo", "team lead", "manager")),
)


def contact_role(domain: str, contact: dict[str, Any]) -> str:
    """The outreach role of a contact, from its stored role or published title."""
    explicit = str(contact.get("role_category") or contact.get("role") or "").strip().lower()
    if explicit:
        return explicit
    title = str(contact.get("job_title") or contact.get("designation") or "").strip().lower()
    if not title:
        return ""
    if domain == "jobs":
        for role, needles in _JOB_TITLE_RULES:
            if any(needle in title for needle in needles):
                return role
    return "other"


def _role_weight(domain: str, contacts: list[dict[str, Any]]) -> tuple[int, list[str]]:
    weights = ROLE_WEIGHTS.get(domain, {})
    best_role, best_weight = None, 0
    for contact in contacts:
        role = contact_role(domain, contact)
        weight = weights.get(role, 0)
        if weight > best_weight:
            best_role, best_weight = role, weight
    reasons = [f"reaches {best_role.replace('_', ' ')}"] if best_role else []
    return best_weight, reasons


def _as_date(value: Any) -> Optional[date]:
    """Coerce a DB value (date/datetime/ISO string) to a date, or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text[:19].replace("Z", "+00:00")).date()
        except ValueError:
            try:
                return datetime.strptime(text[:10], "%Y-%m-%d").date()
            except ValueError:
                return None
    return None


def _days_between(start: Any, end: Any) -> Optional[int]:
    """Signed whole days from ``start`` to ``end``; None if either is unusable."""
    first, second = _as_date(start), _as_date(end)
    if first is None or second is None:
        return None
    return (second - first).days


def freshness_points(
    domain: str,
    record: dict[str, Any],
    *,
    today: Optional[date] = None,
    contacts: Optional[list[dict[str, Any]]] = None,
) -> tuple[int, list[str]]:
    """Domain-correct urgency. Jobs decay in days, colleges in seasons."""
    today = today or datetime.now(timezone.utc).date()
    reasons: list[str] = []
    points = 0

    if domain == "jobs":
        age = _days_between(record.get("posted_at") or record.get("discovered_at"), today)
        if age is None:
            return 0, ["no posting date on record"]
        if age <= 3:
            return 20, ["posted within 3 days"]
        if age <= 14:
            return 14, ["posted within 2 weeks"]
        if age <= 45:
            return 8, ["posted within 45 days"]
        return 0, ["posting is over 45 days old"]
    if domain == "hackathons":
        # Days *until* the deadline: (deadline - today).
        deadline = _days_between(today, record.get("registration_deadline"))
        if deadline is not None and deadline >= 0:
            if deadline <= 14:
                return 22, [f"registration closes in {deadline} day(s)"]
            if deadline <= 45:
                return 14, ["registration window is open"]
            return 8, ["registration announced"]
        start = _days_between(today, record.get("event_start"))
        if start is not None and start >= 0:
            return 6, ["event upcoming"]
        if str(record.get("occurrence_type") or "").upper() in ("PREDICTED", "RECURRING_PATTERN"):
            return 2, ["predicted recurrence (not a confirmed event)"]
        return 0, ["no upcoming window on record"]
    if domain == "colleges":
        month = today.month
        # Placement season (Jul-Dec) is when a TPO conversation lands; Jan-Jun is
        # admissions season, which is a weaker but real hook.
        if 7 <= month <= 12:
            return 12, ["placement season in progress"]
        if 4 <= month <= 6:
            return 8, ["pre-season (admissions) window"]
        return 4, ["off-season for placement outreach"]
    return 0, reasons


# Fields that make a lead worth sending to. Deliberately small and shared, so
# "how much do we know?" means the same thing in every scorer.
DATA_POINT_KEYS: tuple[str, ...] = (
    "city", "state", "website_url", "description", "skills", "themes",
    "technology", "company_name", "organizer_name", "university",
)


def count_data_points(record: dict[str, Any]) -> int:
    return sum(1 for key in DATA_POINT_KEYS if record.get(key) not in (None, "", [], {}))


def readiness_from(
    *,
    has_verified_locator: bool,
    locator_count: int,
    completeness: int,
    data_points: int,
) -> tuple[str, list[str]]:
    """Classify readiness and explain why. Never upgrades on volume alone."""
    blockers: list[str] = []
    if has_verified_locator and locator_count >= 1 and data_points >= 1:
        return "OUTREACH_READY", blockers
    if has_verified_locator and locator_count >= 1:
        blockers.append("lead record is thin — add context before sending")
        return "PARTIALLY_ENRICHED", blockers
    if locator_count >= 1:
        blockers.append("locator discovered but not verified")
        return "PARTIALLY_ENRICHED", blockers
    if completeness >= 30:
        blockers.append("no reachable contact found on any public page")
        return "NEEDS_ENRICHMENT", blockers
    blockers.append("almost nothing known about this record")
    return "INSUFFICIENT_DATA", blockers


def priority_for(score: int, readiness: str) -> str:
    """Buckets a score into an operator-facing priority."""
    if readiness not in ("OUTREACH_READY", "PARTIALLY_ENRICHED"):
        return "P4" if score < 25 else "P3"
    if score >= 75:
        return "P0"
    if score >= 58:
        return "P1"
    if score >= 40:
        return "P2"
    return "P3"


def assess_lead(
    domain: str,
    record: dict[str, Any],
    contacts: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
) -> OutreachAssessment:
    """Score one lead. Deterministic: same rows in, same score out."""
    if domain not in DOMAINS:
        raise ValueError(f"unknown outreach domain: {domain}")
    entity_id = str(record.get("id") or "")
    name = (record.get("name") or record.get("title") or record.get("college_name")
            or record.get("hackathon_name") or "")
    reasons: list[str] = []

    scored: list[tuple[int, list[str], dict[str, Any]]] = [
        (*contact_locator_score(c), c) for c in contacts
    ]
    locator_contacts = [c for score, _, c in scored if score > 0]
    contact_points = max((score for score, _, _ in scored), default=0)
    if contact_points:
        # Explain the reachability of the contact we would actually use.
        top_score = 0
        for score, contact_reasons, _ in sorted(scored, key=lambda item: -item[0]):
            if score > top_score:
                reasons.extend(contact_reasons)
                break
    else:
        # Nothing reachable. Say why, so the operator knows whether to re-enrich
        # or to drop the lead: an unverified gap and a dead mailbox differ.
        seen_notes: set[str] = set()
        for _, contact_reasons, _ in scored:
            for note in contact_reasons:
                if note not in seen_notes:
                    seen_notes.add(note)
        reasons.extend(sorted(seen_notes)[:2])

    role_points, role_reasons = _role_weight(domain, contacts)
    reasons.extend(role_reasons)
    fresh_points, fresh_reasons = freshness_points(domain, record, today=today, contacts=contacts)
    reasons.extend(fresh_reasons)

    completeness = int(record.get("completeness_score") or 0)
    data_points = count_data_points(record)

    verified_locator = any(
        str(c.get("verification_status") or "").lower() in VERIFIED_STATES
        and (c.get("email") or c.get("personal_email") or c.get("phone") or c.get("personal_mobile"))
        for c in contacts
    )
    sendable_email = any(
        str(c.get("verification_status") or "").lower() in VERIFIED_STATES
        and (c.get("email") or c.get("personal_email"))
        for c in contacts
    )
    readiness, readiness_blockers = readiness_from(
        has_verified_locator=verified_locator or sendable_email,
        locator_count=len(locator_contacts),
        completeness=completeness,
        data_points=data_points,
    )

    raw = contact_points + role_points + fresh_points
    score = max(0, min(100, raw))
    assessment = OutreachAssessment(
        domain=domain,
        entity_id=entity_id,
        name=str(name or "")[:200],
        score=score,
        priority=priority_for(score, readiness),
        readiness=readiness,
        best_contact=best_contact(contacts),
        reasons=reasons[:8],
        blockers=readiness_blockers,
    )
    return assessment


# ------------------------------------------------------------ bulk queries ----


# Every query is parameterised — callers pass limits/ids, never SQL text. Table
# names come from these constants, never from a request.
_CONTACT_TABLES: dict[str, tuple[str, str]] = {
    "hackathons": ("hackathon_contacts", "hackathon_id"),
    "colleges": ("college_contacts", "college_id"),
}

# Where an assessment is denormalised so list views can sort without a join.
ASSESSMENT_TABLES: dict[str, str] = {
    "jobs": "leads",
    "hackathons": "hackathons",
    "colleges": "colleges",
}


def table_for(domain: str) -> str:
    if domain not in ASSESSMENT_TABLES:
        raise ValueError(f"unknown outreach domain: {domain}")
    return ASSESSMENT_TABLES[domain]


async def load_contacts(conn, domain: str, entity_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Fetch contact rows for many leads in one query (no N+1 per lead)."""
    if domain not in DOMAINS:
        raise ValueError(f"unknown outreach domain: {domain}")
    if not entity_ids:
        return {}
    if domain == "jobs":
        # A job lead points at exactly one HR contact through hr_contact_id.
        rows = await conn.fetch(
            """
            SELECT l.id AS lead_id, hc.*
              FROM leads l JOIN hr_contacts hc ON hc.id = l.hr_contact_id
             WHERE l.id = ANY($1::uuid[])
            """,
            entity_ids,
        )
        grouped_jobs: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            data = dict(row)
            grouped_jobs.setdefault(str(data.pop("lead_id", None)), []).append(data)
        return grouped_jobs
    table, column = _CONTACT_TABLES[domain]
    rows = await conn.fetch(
        f"""SELECT * FROM {table} WHERE {column} = ANY($1::uuid[])""",  # noqa: S608 - table/column are constants above
        entity_ids,
    )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        data = dict(row)
        grouped.setdefault(str(data.get(column)), []).append(data)
    return grouped


async def persist_assessment(
    conn, assessment: "OutreachAssessment", *, assessed_at: Optional[Any] = None
) -> None:
    """Denormalise the score onto the lead row.

    The API can always recompute, but storing it means an operator can sort and
    filter the whole database without running scoring in a request.
    """
    table = table_for(assessment.domain)
    await conn.execute(
        f"""
        UPDATE {table} SET outreach_score = $2, outreach_priority = $3,
                           outreach_readiness = $4, outreach_assessed_at = NOW()
         WHERE id = $1
        """,  # noqa: S608 - table validated by table_for()
        assessment.entity_id, assessment.score, assessment.priority, assessment.readiness,
    )


async def assess_domain(
    conn,
    domain: str,
    records: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
) -> list[OutreachAssessment]:
    """Assess a batch of leads of one domain."""
    ids = [str(r.get("id")) for r in records if r.get("id")]
    contacts_by_id = await load_contacts(conn, domain, ids)
    return [
        assess_lead(domain, r, contacts_by_id.get(str(r.get("id")), []), today=today)
        for r in records
    ]


def rank(assessments: Iterable[OutreachAssessment]) -> list[OutreachAssessment]:
    """Highest-value first; ties broken by readiness then name for stability."""
    order = {name: i for i, name in enumerate(READINESS_ORDER)}
    return sorted(
        assessments,
        key=lambda a: (-a.score, order.get(a.readiness, 99), a.name.lower()),
    )
