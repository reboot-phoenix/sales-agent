"""Store deliverability verdicts against the contact rows that hold the address.

``email_verify`` decides; this module writes the decision down. Keeping the two
apart means the verification rules stay pure and testable while the persistence
rules (which rows to check, how a downgrade is recorded, how re-checks are
scheduled) live in one place shared by the college and hackathon pipelines.

A verdict never deletes a contact. A mailbox that hard-rejects is marked
``failed`` with grade NULL so no rep sends to it, but the row — and its provenance
— stays for the audit trail and for a later re-check, since mail servers change.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable, Optional

from .email_verify import EmailVerification, verify_email, verification_sql_status

logger = logging.getLogger(__name__)

Verifier = Callable[[str], EmailVerification]

# Which table holds contacts for each domain, and the FK column pointing at the
# lead. Constants only — never interpolated from user input.
CONTACT_TABLES: dict[str, tuple[str, str]] = {
    "colleges": ("college_contacts", "college_id"),
    "hackathons": ("hackathon_contacts", "hackathon_id"),
}

VERIFIED_STATES = ("verified", "cross_verified")

# States worth re-checking: never checked, or checked long enough ago that the
# answer may have changed.
_RECHECK_STATES = ("unverified", "partially_verified", "unknown", "")


def _sql_table(domain: str) -> tuple[str, str]:
    if domain not in CONTACT_TABLES:
        raise ValueError(f"unknown contact domain: {domain}")
    return CONTACT_TABLES[domain]


async def verify_contact_emails(
    conn,
    domain: str,
    entity_id: str,
    *,
    limit: int = 12,
    verifier: Optional[Verifier] = None,
    only_unverified: bool = True,
) -> dict[str, Any]:
    """Verify the emails on one lead's contacts and persist the verdicts.

    Returns ``{"checked", "verified", "catch_all", "undeliverable", "skipped"}``.
    Errors on individual addresses are logged and counted, never raised: one
    broken mailbox must not abort a lead's enrichment.
    """
    table, column = _sql_table(domain)
    rows = await conn.fetch(
        f"""
        SELECT id, email, verification_status FROM {table}
         WHERE {column} = $1
           AND NULLIF(TRIM(COALESCE(email, '')), '') IS NOT NULL
         ORDER BY (verification_status IN ('verified', 'cross_verified')) ASC,
                  updated_at ASC
         LIMIT $2
        """,  # noqa: S608 - identifiers are constants from CONTACT_TABLES
        entity_id, max(1, min(limit, 50)),
    )

    check = verifier or (lambda email: verify_email(email))
    stats = {"checked": 0, "verified": 0, "catch_all": 0, "undeliverable": 0, "skipped": 0}
    for row in rows:
        email = (row["email"] or "").strip()
        current = str(row["verification_status"] or "").lower()
        if only_unverified and current not in _RECHECK_STATES:
            stats["skipped"] += 1
            continue
        try:
            verdict = check(email)
        except Exception as e:  # noqa: BLE001 - a verifier fault is not a data verdict
            logger.warning("verification raised for contact %s: %s", row["id"], e)
            stats["skipped"] += 1
            continue
        stats["checked"] += 1
        status = verdict.status
        if status == "verified":
            stats["verified"] += 1
        elif status == "catch_all":
            stats["catch_all"] += 1
        elif status == "undeliverable":
            stats["undeliverable"] += 1
        await persist_verdict(conn, table, row["id"], verdict)
    return stats


async def persist_verdict(conn, table: str, contact_id: Any, verdict: EmailVerification) -> None:
    """Write one verdict, preserving the previous state in field_provenance."""
    if table not in {t for t, _ in CONTACT_TABLES.values()}:
        raise ValueError(f"refusing to write a verdict to unexpected table: {table}")
    sql_status = verification_sql_status(verdict.status)
    grade = verdict.grade
    await conn.execute(
        f"""
        UPDATE {table} SET
          verification_status = $2,
          verification_grade = COALESCE($3, verification_grade),
          field_provenance = COALESCE(field_provenance, '{{}}'::jsonb)
            || jsonb_build_object('email_verification', $4::jsonb),
          updated_at = NOW()
        WHERE id = $1
        """,  # noqa: S608 - table validated against the constant list above
        contact_id,
        sql_status,
        grade,
        json.dumps({
            **verdict.to_dict(),
            "sql_status": sql_status,
            "previous_grade_kept": grade is None,
        }),
    )


async def reverify_stale_contacts(conn, *, limit: int = 50) -> dict[str, int]:
    """Re-check contacts whose deliverability verdict is old or missing.

    Ordered by lead priority: a college whose TPO address was never checked beats
    one whose fifth alternate contact is merely stale.
    """
    rows = await conn.fetch(
        """
        SELECT cc.id, cc.college_id AS entity_id, cc.email
          FROM college_contacts cc
         WHERE NULLIF(TRIM(COALESCE(cc.email, '')), '') IS NOT NULL
           AND (cc.verification_status IN ('unverified', 'partially_verified')
                OR cc.field_provenance->'email_verification'->>'checked_at' IS NULL)
         ORDER BY CASE cc.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
                  cc.updated_at ASC
         LIMIT $1
        """,
        max(1, min(limit, 500)),
    )
    checked = verified = 0
    for row in rows:
        verdict = verify_email(row["email"])
        checked += 1
        if verdict.status == "verified":
            verified += 1
        await persist_verdict(conn, "college_contacts", row["id"], verdict)
    return {"checked": checked, "verified": verified}
