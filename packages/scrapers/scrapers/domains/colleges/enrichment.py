"""College contact enrichment.

Contact enrichment is the product priority: a college row without a reachable,
relevant person has little outreach value. This module extracts role-based
contacts from PUBLIC institution pages (contact/placement/administration) and
stores them with full provenance.

Hard rules enforced here:
  * never invent a contact — no name without a locator, no guessed email pattern
  * never copy a person from another organization (extraction is per-page, and
    LinkedIn/Twitter share links are rejected as contacts)
  * never overwrite a verified contact with a weaker unverified one
  * respect robots.txt (delegated to utils.http_client/robots) and read only
    public pages — no logins, paywalls or private profiles
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from .. import contact_discovery
from ..contact_waterfall import EMAIL_IN_TEXT
from ..entity_resolution import contact_identity
from ..normalize import clean_text, extract_domain
from ..quality import (
    COLLEGE_ROLE_PRIORITY,
    completeness_score,
    confidence_score,
    freshness_category,
    priority_for_role,
    verification_score,
)

logger = logging.getLogger(__name__)

try:
    from bs4 import BeautifulSoup
    _HAVE_BS4 = True
except Exception:  # noqa: BLE001
    _HAVE_BS4 = False

# Ordered most-specific first: a page saying "Training & Placement Officer" must
# classify as TPO, not fall through to the generic "officer" bucket.
ROLE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("tpo", (r"training\s*(?:&|and)\s*placement\s*officer", r"\bt\.?p\.?o\.?\b",
             r"placement\s*officer", r"training\s*(?:&|and)\s*placement\s*in[- ]?charge")),
    ("placement_head", (r"placement\s*head", r"head\s*[-,]?\s*(?:of\s+)?placement",
                        r"training\s*(?:&|and)\s*placement\s*head")),
    ("placement_cell", (r"placement\s*cell", r"placements?\s*(?:office|department|division)")),
    ("principal", (r"\bprincipal\b",)),
    ("director", (r"\bdirector\b",)),
    ("dean", (r"\bdean\b",)),
    ("hod", (r"\bhod\b", r"head\s*of\s*the\s*department", r"head\s*[-,]?\s*department")),
    ("official", (r"\bregistrar\b", r"administrative\s*officer", r"\bofficer\b")),
)

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?:\+?\d[\d\s\-().]{7,}\d)")
# Titles are optional, and a name token may be an initial ('A B Sharma'), so
# each token allows a single letter. At least two tokens are required — one
# lone capitalised word next to a designation is a department, not a person.
_NAME_TITLE_RE = re.compile(
    r"((?:Dr|Prof|Mr|Mrs|Ms|Shri|Smt)\.?\s+)?"
    r"([A-Z][a-zA-Z.]*(?:\s+[A-Z][a-zA-Z.]*){1,3})"
    r"\s*[,\-–]?\s*(?:is\s+)?(?:the\s+)?"
    r"(Training\s*(?:&|and)\s*Placement|Placement|Principal|Director|Dean|HOD|Head)",
)

# These are never a person's professional contact — they are platform/share links.
REJECTED_EMAIL_DOMAINS = (
    "example.com", "domain.com", "email.com", "yourdomain.com",
)
REJECTED_LOCAL_PARTS = ("noreply", "no-reply", "postmaster", "abuse", "webmaster", "sentry")


def _role_for(text: str) -> Optional[str]:
    lowered = text.lower()
    for role, patterns in ROLE_PATTERNS:
        for pattern in patterns:
            if re.search(pattern, lowered):
                return role
    return None


def _valid_email(email: str) -> bool:
    email = email.strip().lower()
    if not email or "@" not in email:
        return False
    local, _, domain = email.partition("@")
    if not local or domain in REJECTED_EMAIL_DOMAINS:
        return False
    if any(local.startswith(r) for r in REJECTED_LOCAL_PARTS):
        return False
    # An image/CDN filename can end in .png and accidentally match the regex.
    return not re.search(r"\.(png|jpg|jpeg|gif|svg|webp|css|js)$", domain)


def _clean_phone(raw: str) -> Optional[str]:
    digits = re.sub(r"[^\d+]", "", raw)
    if len(re.sub(r"\D", "", digits)) < 10:
        return None
    return digits


def _name_near(text: str, role: str) -> Optional[str]:
    m = _NAME_TITLE_RE.search(text)
    if m:
        prefix = (m.group(1) or "").strip()
        name = f"{prefix} {m.group(2)}".strip() if prefix else m.group(2)
        return clean_text(name, 120) or None
    return None


def _segments(html: str) -> list[str]:
    """Text windows around every locator, plus role-bearing lines.

    A contact's designation lives in the text around their email/phone, so the
    window is what carries meaning; extracting the email alone loses the role.
    """
    windows: list[str] = []
    if _HAVE_BS4:
        soup = BeautifulSoup(html or "", "lxml")
        for anchor in soup.find_all(["a"]):
            href = anchor.get("href") or ""
            if href.lower().startswith(("mailto:", "tel:")):
                parent = anchor.find_parent(["li", "tr", "div", "p", "td", "section"]) or anchor
                windows.append(parent.get_text(" ", strip=True)[:500])
        for cell in soup.find_all(["li", "tr", "td", "p", "div"]):
            text = cell.get_text(" ", strip=True)
            if text and _role_for(text):
                windows.append(text[:500])
    if not windows:
        # Fallback: split raw text into lines/sentences.
        text = re.sub(r"<[^>]+>", " ", html or "")
        for chunk in re.split(r"[\n\r]+|(?<=[.;])\s{2,}", text):
            if chunk.strip():
                windows.append(chunk.strip()[:500])
    return windows


def extract_role_contacts(html: str, source_url: str, *, max_contacts: int = 50) -> list[dict[str, Any]]:
    """Extract role-tagged contacts from one public page.

    Pure and deterministic. A result always has a locator (email/phone/LinkedIn);
    a role or name by itself is never emitted as a contact.
    """
    if not html:
        return []
    contacts: list[dict[str, Any]] = []
    seen: set[str] = set()

    for window in _segments(html):
        role = _role_for(window)
        emails = [e for e in _EMAIL_RE.findall(window) if _valid_email(e)]
        phones = [p for p in _PHONE_RE.findall(window)]
        linkedin = None
        for link in re.findall(r"https?://[^\s\"'<>]*linkedin\.com/(?:in|pub)/[^\s\"'<>]+", window, re.I):
            linkedin = link
            break
        if not (emails or phones or linkedin):
            continue
        if role is None and not linkedin:
            # A generic inbox with no role is still worth keeping as 'official'
            # only when it is clearly an institution address, not a person's.
            if emails and any(re.search(r"(info|contact|office|principal|placement|admin)@", e.lower()) for e in emails):
                role = "official"
            else:
                continue
        name = _name_near(window, role) if role else None
        email = emails[0] if emails else None
        phone = _clean_phone(phones[0]) if phones else None
        identity = contact_identity(name, email, phone, linkedin)
        if not identity or identity in seen:
            continue
        seen.add(identity)
        contacts.append({
            "full_name": name,
            "designation": _designation_snippet(window, role),
            "role_category": role or "other",
            "priority": priority_for_role("colleges", role or "other"),
            "email": email,
            "phone": phone,
            "linkedin_url": linkedin,
            "contact_source": "official_website",
            "source_url": source_url,
            "verification_status": "unverified",
            "confidence_score": 70 if email else (55 if phone else 45),
        })
        if len(contacts) >= max_contacts:
            break
    return contacts


def _designation_snippet(window: str, role: Optional[str]) -> Optional[str]:
    if not role:
        return None
    for _r, patterns in ROLE_PATTERNS:
        for pattern in patterns:
            m = re.search(pattern, window, re.I)
            if m:
                start = max(0, m.start() - 10)
                return clean_text(window[start:m.end() + 20], 120) or None
    return None


# Page discovery lives in contact_discovery so the college and hackathon domains
# share one fallback chain (known paths -> sitemap -> homepage role links).
CONTACT_PATHS = contact_discovery.CONTACT_PATHS


def candidate_contact_urls(website_url: Optional[str]) -> list[str]:
    """Build the bounded list of public pages to check for a college."""
    return contact_discovery.candidate_contact_urls(website_url)


async def upsert_college_contact(conn, college_id: str, contact: dict[str, Any]) -> bool:
    """Insert a contact, or enrich an existing one without downgrading it.

    A verified contact is never replaced by an unverified duplicate: the existing
    row wins and only its empty fields are backfilled. Returns True when a row was
    inserted.
    """
    identity = contact_identity(contact.get("full_name"), contact.get("email"),
                                contact.get("phone"), contact.get("linkedin_url"))
    if not identity:
        return False
    existing = None
    if contact.get("email"):
        existing = await conn.fetchrow(
            "SELECT * FROM college_contacts WHERE college_id=$1 AND lower(email)=lower($2) LIMIT 1",
            college_id, contact["email"],
        )
    if existing is None and contact.get("phone"):
        existing = await conn.fetchrow(
            "SELECT * FROM college_contacts WHERE college_id=$1 AND phone=$2 LIMIT 1",
            college_id, contact["phone"],
        )
    if existing is None and contact.get("linkedin_url"):
        existing = await conn.fetchrow(
            "SELECT * FROM college_contacts WHERE college_id=$1 AND lower(linkedin_url)=lower($2) LIMIT 1",
            college_id, contact["linkedin_url"],
        )
    if existing:
        existing_status = (existing.get("verification_status") or "unverified").lower()
        incoming_status = (contact.get("verification_status") or "unverified").lower()
        # Strong verification is sticky: a weaker source may only fill gaps.
        if existing_status in ("verified", "cross_verified") and incoming_status not in ("verified", "cross_verified"):
            await conn.execute(
                """UPDATE college_contacts SET
                     full_name=COALESCE(full_name,$2), designation=COALESCE(designation,$3),
                     department=COALESCE(department,$4), linkedin_url=COALESCE(linkedin_url,$5),
                     updated_at=NOW()
                   WHERE id=$1""",
                existing["id"], contact.get("full_name"), contact.get("designation"),
                contact.get("department"), contact.get("linkedin_url"),
            )
            return False
        await conn.execute(
            """UPDATE college_contacts SET
                 full_name=$2, designation=$3, role_category=$4, priority=$5,
                 email=COALESCE($6, email), phone=COALESCE($7, phone),
                 linkedin_url=COALESCE($8, linkedin_url), contact_source=$9,
                 source_url=$10, confidence_score=GREATEST(confidence_score,$11),
                 updated_at=NOW()
               WHERE id=$1""",
            existing["id"], contact.get("full_name"), contact.get("designation"),
            contact.get("role_category"), contact.get("priority"),
            contact.get("email"), contact.get("phone"), contact.get("linkedin_url"),
            contact.get("contact_source"), contact.get("source_url"),
            int(contact.get("confidence_score") or 0),
        )
        return False
    await conn.execute(
        """INSERT INTO college_contacts
             (college_id, full_name, designation, role_category, priority, department,
              email, phone, linkedin_url, verification_status, contact_source,
              source_url, confidence_score, field_provenance)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)""",
        college_id, contact.get("full_name"), contact.get("designation"),
        contact.get("role_category") or "other", contact.get("priority") or "P4",
        contact.get("department"), contact.get("email"), contact.get("phone"),
        contact.get("linkedin_url"), contact.get("verification_status") or "unverified",
        contact.get("contact_source"), contact.get("source_url"),
        int(contact.get("confidence_score") or 0),
        json.dumps({"source": contact.get("contact_source"), "at": contact.get("source_url")}),
    )
    return True


async def recompute_college_quality(conn, college_id: str) -> dict[str, Any]:
    """Recompute completeness/confidence/outreach-readiness from stored contacts."""
    college = dict(await conn.fetchrow("SELECT * FROM colleges WHERE id=$1", college_id) or {})
    if not college:
        return {}
    contacts = await conn.fetch(
        """SELECT role_category, priority, email, phone, linkedin_url, verification_status
             FROM college_contacts WHERE college_id=$1""",
        college_id,
    )
    contact_dicts = [dict(c) for c in contacts]
    has_locator = bool(contact_dicts)
    coverage = {
        "contacts": len(contact_dicts),
        "emails": sum(1 for c in contact_dicts if c.get("email")),
        "phones": sum(1 for c in contact_dicts if c.get("phone")),
        "linkedin": sum(1 for c in contact_dicts if c.get("linkedin_url")),
        "verified": sum(1 for c in contact_dicts
                        if (c.get("verification_status") or "").lower() in ("verified", "cross_verified")),
        "by_role": _count_by(contact_dicts, "role_category"),
        "best_priority": _best_priority(contact_dicts),
    }
    # Denormalize the highest-priority person of each key role onto the college
    # row so list views can show "TPO: <name>" without a join per row.
    updates: dict[str, Any] = {}
    for role, column in (("tpo", "tpo_name"), ("principal", "principal_name"),
                         ("director", "director_name"), ("dean", "dean_name"),
                         ("placement_head", "placement_head_name")):
        person = next((c for c in contact_dicts if c.get("role_category") == role), None)
        if person and not college.get(column):
            updates[column] = person.get("full_name")
    tpo = next((c for c in contact_dicts if c.get("role_category") == "tpo"), None)
    if tpo:
        if tpo.get("email") and not college.get("tpo_email"):
            updates["tpo_email"] = tpo["email"]
        if tpo.get("phone") and not college.get("tpo_phone"):
            updates["tpo_phone"] = tpo["phone"]

    from ..outreach import assess_lead, persist_assessment

    contact_verified = any(
        (c.get("verification_status") or "").lower() in ("verified", "cross_verified")
        for c in contact_dicts
    )
    merged = {**college, **updates}
    completeness, _ = completeness_score("colleges", merged)
    verification = verification_score(college)
    confidence = confidence_score("colleges", college, contact_verified=contact_verified)
    # The outreach assessment is the single authority for readiness and also
    # produces the sendability score the queue sorts on.
    assessment = assess_lead("colleges", merged, contact_dicts)
    readiness = assessment.readiness
    enrichment_status = "ENRICHED" if has_locator else "NEEDS_ENRICHMENT"
    await conn.execute(
        """UPDATE colleges SET
             contact_coverage=$2::jsonb, completeness_score=$3, confidence_score=$4,
             freshness_score=$5, freshness_category=$6, outreach_readiness=$7,
             enrichment_status=$8, last_verified_at=COALESCE(last_verified_at, NOW()),
             updated_at=NOW()
           WHERE id=$1""",
        college_id, json.dumps(coverage), completeness, confidence,
        _freshness_score(college), freshness_category("colleges", college),
        readiness, enrichment_status,
    )
    await persist_assessment(conn, assessment)
    from ..quality import persist_quality
    await persist_quality(
        conn, "colleges", college_id, merged,
        has_contact_locator=has_locator, enrichment_status=enrichment_status,
    )
    return {"coverage": coverage, "completeness": completeness, "confidence": confidence,
            "readiness": readiness, "outreach_score": assessment.score,
            "outreach_priority": assessment.priority, "contacts": len(contact_dicts)}


def _count_by(items: list[dict], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        value = item.get(key) or "other"
        counts[value] = counts.get(value, 0) + 1
    return counts


def _best_priority(items: list[dict]) -> Optional[str]:
    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
    valid = [i.get("priority") for i in items if i.get("priority") in order]
    return sorted(valid, key=lambda p: order[p])[0] if valid else None


def _freshness_score(college: dict) -> int:
    from ..quality import freshness_score
    return freshness_score("colleges", college)


async def enrich_college(conn, college_id: str, *, fetch_pages: bool = True) -> dict[str, Any]:
    """Fetch a college's public contact pages and store the role contacts found."""
    college = dict(await conn.fetchrow("SELECT * FROM colleges WHERE id=$1", college_id) or {})
    if not college:
        return {"status": "not_found"}
    run_id = await conn.fetchval(
        "INSERT INTO enrichment_runs (domain, entity_id, status, stages) VALUES ('colleges',$1,'running','[]'::jsonb) RETURNING id",
        college_id,
    )
    inserted = 0
    fetched = 0
    errors: list[str] = []
    providers_used: list[str] = []
    # Real addresses seen on the college's own pages feed the waterfall's
    # pattern-inference layer (a learned format beats a guessed one).
    harvested_emails: list[str] = [e for e in (
        (c.get("email") or "").strip() for c in await conn.fetch(
            "SELECT email FROM college_contacts WHERE college_id=$1 AND email IS NOT NULL",
            college_id,
        )) if e]
    urls = candidate_contact_urls(college.get("website_url"))
    if fetch_pages and urls:
        # Widen beyond guessable paths: the site's own sitemap and homepage links
        # often point at the placement page that guessing misses.
        urls = await contact_discovery.discover_contact_urls(college.get("website_url"))
    if urls and fetch_pages:
        from ...utils.http_client import fetch
        for url in urls:
            try:
                resp = await fetch(url, timeout=25, min_engine="httpx", max_engine="playwright")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{url}: {e}")
                continue
            if resp.status != 200 or not resp.text:
                continue
            fetched += 1
            harvested_emails.extend(EMAIL_IN_TEXT.findall(resp.text))
            contacts = extract_role_contacts(resp.text, url)
            for contact in contacts:
                try:
                    if await upsert_college_contact(conn, college_id, contact):
                        inserted += 1
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{url} contact: {e}")
    elif not urls:
        errors.append("no official website on record — cannot enrich")

    # Free OSINT waterfall — runs BEFORE any paid provider (free-first rule).
    # Even when page extraction found a contact, the role-inbox layer adds the
    # placement-cell mailboxes pages don't always print, and the pattern layer
    # builds the TPO's personal address from any real sample we harvested.
    waterfall_report: dict[str, Any] = {}
    if fetch_pages and college.get("website_url"):
        try:
            from ..contact_waterfall import run_contact_waterfall
            wf = await run_contact_waterfall(
                college.get("website_url"),
                person_name=college.get("tpo_name") or college.get("principal_name"),
                known_emails=harvested_emails,
                role_limit=6,
            )
            waterfall_report = wf.get("report", {})
            for cand in wf.get("candidates", []):
                if not cand.get("email"):
                    continue
                email_local = (cand["email"] or "").split("@", 1)[0].lower()
                role_category = "other"
                for rc, needle in (("tpo", "tpo"), ("placement_head", "placement"),
                                   ("principal", "principal"), ("director", "director"),
                                   ("dean", "dean")):
                    if needle in email_local:
                        role_category = rc
                        break
                contact = {
                    "email": cand["email"],
                    "full_name": None,  # a shared/role inbox is not a person
                    "role_category": role_category,
                    "contact_source": f"osint_waterfall_{cand.get('layer', 'unknown')}",
                    "source_url": college.get("website_url"),
                    "confidence_score": cand.get("confidence", 40),
                    # Only an explicit SMTP acceptance may be stored pre-verified;
                    # anything else enters as unverified and is re-checked below.
                    "verification_status": "verified" if cand.get("verified") else "unverified",
                }
                try:
                    if await upsert_college_contact(conn, college_id, contact):
                        inserted += 1
                except Exception as e:  # noqa: BLE001
                    errors.append(f"waterfall contact: {e}")
            # The waterfall already SMTP-verified every candidate it returned;
            # record those verdicts so the verify pass does not re-probe them.
            if inserted:
                from ..verification import record_waterfall_verdicts
                await record_waterfall_verdicts(conn, "colleges", college_id, wf)
        except Exception as e:  # noqa: BLE001 — the waterfall must never fail a run
            errors.append(f"waterfall: {e}")

    # Last resort: credentialed providers. They only run when configured, and their
    # output goes through the same upsert (provenance, dedupe, no downgrades).
    if fetch_pages and inserted == 0:
        from ..providers import enrich_with_providers
        try:
            provider_result = await enrich_with_providers(website_domain=college.get("website_url"), limit=10)
            providers_used = list(provider_result.get("providers_used") or [])
            for contact in provider_result.get("contacts") or []:
                try:
                    if await upsert_college_contact(conn, college_id, contact):
                        inserted += 1
                except Exception as e:  # noqa: BLE001
                    errors.append(f"provider contact: {e}")
            errors.extend(f"provider {e}" for e in (provider_result.get("errors") or [])[:5])
        except Exception as e:  # noqa: BLE001 - provider trouble never fails enrichment
            errors.append(f"providers: {e}")
    # Check deliverability of what we just found. This is what turns a discovered
    # address into one a rep may actually send to — and demotes a dead mailbox
    # before it reaches anyone's queue.
    verification_stats: dict[str, Any] = {}
    if inserted or fetched:
        from ..verification import verify_contact_emails

        try:
            verification_stats = await verify_contact_emails(conn, "colleges", college_id)
        except Exception as e:  # noqa: BLE001 - a verifier fault never fails enrichment
            errors.append(f"verification: {e}")
    quality = await recompute_college_quality(conn, college_id)
    await conn.execute(
        """UPDATE enrichment_runs SET status=$2, finished_at=NOW(), contacts_found=$3,
             attempts=attempts+1, stages=$4::jsonb, error=$5::jsonb WHERE id=$1""",
        run_id, "completed" if not errors else "partial", inserted,
        json.dumps({"pages_fetched": fetched, "candidate_urls": len(urls),
                    "providers_used": providers_used,
                    "osint_waterfall": waterfall_report,
                    "verification": verification_stats}),
        json.dumps(errors[:20]) if errors else None,
    )
    return {"status": "completed", "pages_fetched": fetched, "contacts_inserted": inserted,
            "providers_used": providers_used, "verification": verification_stats,
            "osint_waterfall": waterfall_report,
            "errors": errors[:5], **quality}


async def enrich_pending_colleges(conn, limit: int = 50, *, fetch_pages: bool = True) -> dict[str, int]:
    """Prioritized re-enrichment queue.

    Ordering follows the spec's intent: high-value recent leads first, then
    records that already have partial contact information (cheapest to complete),
    then everything else with a website.
    """
    rows = await conn.fetch(
        """
        SELECT c.id FROM colleges c
         WHERE c.is_active
           AND c.website_url IS NOT NULL
           AND (c.enrichment_status <> 'ENRICHED'
                OR NOT EXISTS (SELECT 1 FROM college_contacts cc WHERE cc.college_id = c.id))
         ORDER BY
           (c.contact_coverage->>'contacts')::int NULLS FIRST,
           c.created_at DESC
         LIMIT $1
        """,
        limit,
    )
    processed = enriched = 0
    for row in rows:
        processed += 1
        try:
            result = await enrich_college(conn, str(row["id"]), fetch_pages=fetch_pages)
            if result.get("contacts_inserted"):
                enriched += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("college enrich failed for %s: %s", row["id"], e)
    return {"processed": processed, "enriched": enriched}
