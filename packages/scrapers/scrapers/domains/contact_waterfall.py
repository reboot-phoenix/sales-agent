"""Shared OSINT contact waterfall for the college and hackathon armies.

The jobs army has a deep free-first cascade (GitHub commit mining → pattern
inference → SERP dorks → crt.sh/Wayback → Gravatar → paid last). The college
and hackathon enrichers historically stopped after direct page extraction and
jumped straight to paid providers — missing the highest-yield free sources for
institutions, whose outreach is dominated by ROLE INBOXES (`tpo@college.ac.in`,
`placements@college.edu`) rather than personal addresses.

This module ports the jobs waterfall to the domains, with institution-specific
adaptations:

Layer R — **role inbox discovery + verification** (institutions publish these
          in plain sight; they reach the placement cell reliably):
            tpo@, placements@, placement@, placementcell@, principal@,
            director@, info@, office@, admission@, contact@ … on the
            entity's own domain. Every accepted inbox passes a live SMTP
            check first — a role address that the mail server rejects is
            NEVER stored.
Layer P — **personal-email pattern inference**: if we already hold a real
          address at the domain (from pages/crt.sh/Wayback), infer the
          institution's local-part format and build the TPO/principal's
          personal address from it, then SMTP-verify. Inference from a real
          sample is evidence; blind guessing without one is not done here.
Layer D — **SERP dorks**: published `tpo@domain` / `"name" domain email`
          pages via keyless engines (same module the jobs army uses).

Everything runs through the strict quality gate before a caller stores
anything: role/personal classification, live SMTP verification (verified |
catch_all | unknown | undeliverable), and confidence caps. A contact that
fails verification is reported, never stored. Nothing here overwrites an
existing contact — callers merge with COALESCE/GREATEST semantics.

Only lawful public sources: no auth bypass, no paywalls, no CAPTCHA evasion,
no bulk-harvesting of personal data beyond what the institution itself
publishes for placement/contact purposes.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

EMAIL_IN_TEXT = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def _verify(email: str, *, check_smtp: bool = True):
    """Verification seam — the single call site for deliverability checks.

    Kept as a module-level function (rather than a function-local import) so
    tests can inject verdicts without touching the network.
    """
    from .email_verify import verify_email

    return verify_email(email, check_smtp=check_smtp)


def _verify_dict(email: str, *, check_smtp: bool = True) -> dict[str, Any]:
    """Dict-shaped variant for ``asyncio.to_thread`` call sites."""
    v = _verify(email, check_smtp=check_smtp)
    return {"status": v.status, "smtp_code": v.smtp_code, "mx_hosts": v.mx_hosts}

# Role inboxes that matter for outreach, best first. These are the shared
# mailboxes institutions publish on placement/contact pages — they reach the
# placement cell even when no named officer's address is public.
ROLE_INBOX_LOCALS: tuple[str, ...] = (
    "tpo", "tpo.cell", "tpocell", "tpooffice",
    "placements", "placement", "placementcell", "placement.cell",
    "training.placement", "tnp", "tnpcell",
    "principal", "directors", "director", "dean",
    "registrar", "hod",
    "admissions", "admission", "admissioncell",
    "info", "office", "contact", "admin",
)

# Confidence scores for the waterfall layers (0..100, matching the DB scale).
CONF_ROLE_SMTP_VERIFIED = 78     # role inbox: MX + explicit RCPT accept
CONF_ROLE_MX_ONLY = 45           # role inbox: MX valid, SMTP inconclusive
CONF_ROLE_CATCH_ALL = 40         # accepted but domain is catch-all
CONF_PERSONAL_INFERRED_VERIFIED = 72   # pattern-inferred personal + SMTP verified
CONF_PERSONAL_PUBLISHED = 80     # published on an official page (verified separately)


@dataclass
class WaterfallContact:
    """One candidate contact with full provenance, ready for the upsert gate."""

    email: str
    layer: str                       # role_inbox | pattern_inferred | serp_published
    confidence: int
    verified: bool                   # explicit SMTP acceptance
    status: str                      # verified | catch_all | unknown | undeliverable
    role_address: bool
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "email": self.email,
            "layer": self.layer,
            "confidence": self.confidence,
            "verified": self.verified,
            "status": self.status,
            "role_address": self.role_address,
            "evidence": self.evidence,
        }


# ---------------------------------------------------------------------------
# Domain discovery
# ---------------------------------------------------------------------------

def _host_candidates(website_url: Optional[str]) -> list[str]:
    """The hosts worth probing for mail, best first (apex before www)."""
    from .normalize import extract_domain

    domain = extract_domain(website_url or "")
    if not domain:
        return []
    hosts = [domain]
    if domain.startswith("www."):
        domain = domain[4:]
        hosts = [domain]
    # Academic institutions commonly publish mail under an .ac.in style apex —
    # extract_domain already gives us that. www. variant last: mail is usually
    # accepted at the apex.
    www = f"www.{domain}"
    if www not in hosts:
        hosts.append(www)
    return hosts


# ---------------------------------------------------------------------------
# Layer R: role-inbox discovery + live verification
# ---------------------------------------------------------------------------

async def discover_role_inboxes(
    website_url: Optional[str],
    *,
    check_smtp: bool = True,
    probe_limit: int = 10,
) -> list[WaterfallContact]:
    """Probe the entity's own domain for the role inboxes institutions publish.

    Every candidate is SMTP-verified before it is returned (unless the caller
    disables the check for offline tests); an inbox the mail server rejects is
    dropped, so a stored role address is always a live mailbox.
    """
    from .email_verify import is_role_address

    hosts = _host_candidates(website_url)
    if not hosts:
        return []

    # Build candidates, deduped, order-stable across all hosts.
    candidates: list[str] = []
    seen: set[str] = set()
    for host in hosts:
        for local in ROLE_INBOX_LOCALS:
            addr = f"{local}@{host}"
            if addr not in seen:
                seen.add(addr)
                candidates.append(addr)
        if len(candidates) >= probe_limit * len(hosts):
            break

    results: list[WaterfallContact] = []
    for addr in candidates[:probe_limit * len(hosts)]:
        verdict = await asyncio.to_thread(_verify, addr, check_smtp=check_smtp)
        # A hard rejection is definitive — drop the candidate entirely.
        if verdict.status == "undeliverable":
            continue
        if verdict.status == "verified":
            conf = CONF_ROLE_SMTP_VERIFIED
        elif verdict.status == "catch_all":
            conf = CONF_ROLE_CATCH_ALL
        else:  # unknown: MX fine, SMTP inconclusive
            conf = CONF_ROLE_MX_ONLY
        results.append(WaterfallContact(
            email=addr,
            layer="role_inbox",
            confidence=conf,
            verified=verdict.status == "verified",
            status=verdict.status,
            role_address=is_role_address(addr),
            evidence={"mx_hosts": verdict.mx_hosts, "smtp_code": verdict.smtp_code},
        ))
        # Stop expanding once we hold an explicitly verified inbox — the
        # institution's mail is reachable; more probes add cost, not value.
        if verdict.status == "verified" and len(results) >= 2:
            break
    results.sort(key=lambda c: (-c.confidence, c.email))
    return results


# ---------------------------------------------------------------------------
# Layer P: personal-email pattern inference from known addresses
# ---------------------------------------------------------------------------

def _infer_local_format(sample_local: str, first: str, last: str) -> Optional[str]:
    """Given a real local-part and a person's name, guess the company format."""
    s = sample_local.lower()
    if not first:
        return None
    formats = {
        f"{first}.{last}": "{first}.{last}",
        f"{first}{last}": "{first}{last}",
        f"{first}_{last}": "{first}_{last}",
        f"{first[0]}{last}": "{first[0]}{last}",
        f"{first}.{last[0]}": "{first}.{last[0]}",
        f"{first[0]}.{last}": "{first[0]}.{last}",
    }
    if last:
        # longer keys first so first.last wins over first
        for key in sorted(formats, key=len, reverse=True):
            if s == key:
                return formats[key]
    if s == first:
        return "{first}"
    return None


# Structure of a sample local-part → the template to apply to the target name.
# Structure detection (not name matching) is what lets `r.sharma@` teach us
# the format for Anita Deshmukh: the sample belongs to someone else.
_SAMPLE_STRUCTURES: tuple[tuple[Any, tuple[str, ...]], ...] = (
    (re.compile(r"^([a-z])\.([a-z]+)$"), ("{first[0]}.{last}",)),
    (re.compile(r"^([a-z]+)\.([a-z])$"), ("{first}.{last[0]}",)),
    (re.compile(r"^([a-z])_([a-z]+)$"), ("{first[0]}_{last}",)),
    (re.compile(r"^([a-z]+)_([a-z]+)$"), ("{first}_{last}",)),
    (re.compile(r"^([a-z]+)\.([a-z]+)$"), ("{first}.{last}",)),
    # Ambiguous concatenation: initial+last or first+last. Both are tried;
    # live SMTP verification decides, so a wrong guess is dropped, never stored.
    (re.compile(r"^([a-z])([a-z]+)$"), ("{first[0]}{last}", "{first}{last}")),
    (re.compile(r"^([a-z]+)$"), ("{first}",)),
)


def _render(tpl: str, first: str, last: str) -> str:
    """Apply a local-part template; guarded against empty-slice edge cases."""
    return (tpl.replace("{first[0]}", first[:1])
               .replace("{last[0]}", last[:1])
               .replace("{first}", first)
               .replace("{last}", last))


def _candidate_locals(sample_local: str, first: str, last: str) -> list[str]:
    """Render the target's local-part candidates from the sample's structure."""
    s = (sample_local or "").lower().strip()
    # Skip separators-only or implausibly short samples.
    if len(s) < 2 or not first:
        return []
    for pattern, templates in _SAMPLE_STRUCTURES:
        if pattern.match(s):
            out = []
            for tpl in templates:
                local = _render(tpl, first, last)
                if local and len(local) >= 2 and local not in out:
                    out.append(local)
            return out
    return []


async def infer_personal_email(
    person_name: str,
    domain: str,
    known_emails: list[str],
    *,
    check_smtp: bool = True,
) -> Optional[WaterfallContact]:
    """Infer a person's address from real published addresses at the domain.

    Requires at least one real sample at the same domain — blind permutation
    without a learned pattern is NOT done here (it produces plausible wrong
    addresses, which violate the never-fabricate rule). The inferred address
    must pass live SMTP verification to be returned as verified.
    """
    from .email_verify import is_role_address

    if not person_name or not domain:
        return None
    tokens = re.findall(r"[a-z]+", person_name.lower())
    if not tokens:
        return None
    first = tokens[0]
    last = tokens[-1] if len(tokens) > 1 else ""

    domain = domain.lower().lstrip("@")
    sample = next((e for e in known_emails if e.lower().endswith(f"@{domain}")), None)
    if not sample:
        return None

    sample_local = sample.split("@", 1)[0].lower()
    locals_to_try = _candidate_locals(sample_local, first, last)
    if not locals_to_try:
        return None

    # Only an explicit SMTP acceptance produces a stored personal address: an
    # inferred-but-unverified guess is exactly the "plausible wrong email" the
    # never-fabricate rule forbids. Undeliverable → dropped; unknown/catch-all
    # → dropped too (no verification step happened / acceptance proves nothing).
    for local in locals_to_try:
        candidate = f"{local}@{domain}"
        verdict = await asyncio.to_thread(_verify_dict, candidate, check_smtp=check_smtp)
        if verdict["status"] == "verified":
            return WaterfallContact(
                email=candidate,
                layer="pattern_inferred",
                confidence=CONF_PERSONAL_INFERRED_VERIFIED,
                verified=True,
                status="verified",
                role_address=is_role_address(candidate),
                evidence={"learned_from": sample, "pattern": local, "smtp_code": verdict.get("smtp_code")},
            )
        if verdict["status"] == "undeliverable":
            continue  # wrong format guess; try the next structure
        return None  # unknown/catch-all: no live verification, refuse to store
    return None


def verify_email_safe(email: str, *, check_smtp: bool = True) -> dict[str, Any]:
    """Thread-safe wrapper returning a plain dict (kept for API compatibility)."""
    return _verify_dict(email, check_smtp=check_smtp)


# ---------------------------------------------------------------------------
# Layer D: published role-address discovery via SERP dorks
# ---------------------------------------------------------------------------

_DORK_QUERIES = (
    '"@{domain}" tpo OR placement OR "placement cell"',
    '"@{domain}" principal OR director OR dean email',
    'site:{domain} tpo@ OR placements@ OR placement@',
    '"@{domain}" contact',
)

_DROPPED_LOCAL = re.compile(
    r"^(noreply|no-reply|donotreply|postmaster|abuse|webmaster|mailer-daemon)[0-9]*$"
)


async def discover_archived_addresses(
    website_url: Optional[str],
    *,
    max_results: int = 4,
) -> list[WaterfallContact]:
    """Layer A — Wayback Machine: contacts from *historical* versions of the
    institution's own pages.

    Colleges rotate their TPO/placement pages; the address that vanished from
    today's site usually still worked last year and the mailbox usually still
    exists. Only the entity's OWN domain pages are queried (no third-party
    archives), results are bounded, and everything still passes the SMTP gate
    downstream before anyone sends to it.
    """
    from .normalize import extract_domain

    domain = extract_domain(website_url or "")
    if not domain:
        return []
    try:
        from ..utils.osint_contacts import wayback_emails
    except Exception:  # noqa: BLE001 - archive layer is optional by design
        return []

    found: list[WaterfallContact] = []
    seen: set[str] = set()
    base = f"https://{domain}"
    for path in ("/placement-cell", "/placement", "/contact-us", "/tpo"):
        try:
            emails = await wayback_emails(f"{base}{path}")
        except Exception:  # noqa: BLE001 - one path failing must not sink the layer
            continue
        for em in emails:
            el = (em or "").strip().lower()
            if not el or not el.endswith(f"@{domain}") or el in seen:
                continue
            seen.add(el)
            found.append(WaterfallContact(
                email=el,
                layer="archive",
                # Published by the institution itself (in the past) — decent
                # evidence; the SMTP gate decides whether it is still live.
                confidence=50,
                verified=False,
                status="unknown",
                role_address=True,
                evidence={"origin": f"wayback{path}"},
            ))
            if len(found) >= max_results:
                return found
    return found


async def discover_published_addresses(
    domain: str,
    *,
    max_results: int = 5,
) -> list[WaterfallContact]:
    """Scrape search-engine snippets for addresses the institution published.

    Any `*@domain` printed on an indexed page is a real, self-published
    address (rosters, contact pages, PDF brochures). These still go through
    SMTP verification downstream before anyone sends to them.
    """
    if not domain or domain in (".com", ".edu", ".ac.in"):
        return []
    # Function-local import keeps the seam patchable and the module importable
    # even if the search-engine client's optional deps are missing.
    from ..utils.serp_dork import EMAIL_IN_TEXT, _fetch_snippets

    found: list[WaterfallContact] = []
    seen: set[str] = set()
    for tpl in _DORK_QUERIES:
        query = tpl.format(domain=domain)
        try:
            snippets = await _fetch_snippets(query)
        except Exception:  # noqa: BLE001 — an engine failing must not sink the tier
            continue
        for sn in snippets:
            for m in EMAIL_IN_TEXT.findall(sn):
                el = m.lower()
                if not el.endswith(f"@{domain.lower()}") or el in seen:
                    continue
                local = el.split("@", 1)[0]
                if _DROPPED_LOCAL.match(local):
                    continue
                seen.add(el)
                found.append(WaterfallContact(
                    email=el,
                    layer="serp_published",
                    # Published on the open web is decent evidence, but the
                    # SMTP verdict decides sendability — start mid-scale.
                    confidence=55,
                    verified=False,
                    status="unknown",
                    role_address=local in ROLE_INBOX_LOCALS,
                    evidence={"query": query},
                ))
                if len(found) >= max_results:
                    return found
    return found


# ---------------------------------------------------------------------------
# The full waterfall, ordered cheapest → most specific
# ---------------------------------------------------------------------------

async def run_contact_waterfall(
    website_url: Optional[str],
    *,
    person_name: Optional[str] = None,
    known_emails: Optional[list[str]] = None,
    check_smtp: bool = True,
    role_limit: int = 6,
) -> dict[str, Any]:
    """Run all layers for one entity; returns candidates + a run report.

    Ordering: role inboxes first (an institution's placement inbox is the
    highest-yield verified contact), then the personal inferred address, then
    SERP-published addresses. Nothing here contacts a paid API and nothing
    here raises — a total failure returns an empty candidate list with the
    error recorded in the report, so one bad domain never sinks a sweep.
    """
    report: dict[str, Any] = {
        "layers_run": [],
        "candidates": 0,
        "verified": 0,
        "errors": [],
    }
    domain = _host_candidates(website_url)
    domain_host = domain[0] if domain else None
    if not domain_host:
        return {"candidates": [], "report": {**report, "errors": ["no domain"]}}

    candidates: list[WaterfallContact] = []

    # Layer R — role inboxes on the entity's own domain.
    try:
        role_hits = await discover_role_inboxes(
            website_url, check_smtp=check_smtp, probe_limit=role_limit,
        )
        report["layers_run"].append("role_inbox")
        candidates.extend(role_hits)
    except Exception as e:  # noqa: BLE001
        report["errors"].append(f"role_inbox: {e}")

    # Layer P — personal inference needs real samples (pages we already parsed).
    if person_name and known_emails:
        try:
            personal = await infer_personal_email(
                person_name, domain_host, known_emails, check_smtp=check_smtp,
            )
            report["layers_run"].append("pattern_inferred")
            if personal:
                candidates.append(personal)
        except Exception as e:  # noqa: BLE001
            report["errors"].append(f"pattern_inferred: {e}")

    # Layer D — published addresses from SERP snippets.
    try:
        published = await discover_published_addresses(domain_host)
        report["layers_run"].append("serp_published")
        candidates.extend(published)
    except Exception as e:  # noqa: BLE001
        report["errors"].append(f"serp_published: {e}")

    # Layer A — historical (Wayback) addresses from the entity's own pages.
    try:
        archived = await discover_archived_addresses(website_url)
        report["layers_run"].append("archive")
        candidates.extend(archived)
    except Exception as e:  # noqa: BLE001
        report["errors"].append(f"archive: {e}")

    # Final gate: verify anything that arrived unverified (SERP layer) and
    # drop hard rejections so the caller only sees live or inconclusive mail.
    final: list[WaterfallContact] = []
    seen: set[str] = set()
    for c in candidates:
        if c.email.lower() in seen:
            continue
        seen.add(c.email.lower())
        if c.status not in ("verified", "catch_all") and check_smtp:
            verdict = await asyncio.to_thread(_verify_dict, c.email, check_smtp=True)
            c.status = verdict["status"]
            c.verified = verdict["status"] == "verified"
            c.confidence = {
                "verified": max(c.confidence, CONF_PERSONAL_PUBLISHED if c.layer == "serp_published" else c.confidence),
                "catch_all": min(c.confidence, CONF_ROLE_CATCH_ALL),
                "unknown": min(c.confidence, CONF_ROLE_MX_ONLY),
            }.get(c.status, 0)
            if c.status == "undeliverable":
                continue
        if c.verified:
            report["verified"] += 1
        final.append(c)

    final.sort(key=lambda c: (-c.confidence, c.email))
    report["candidates"] = len(final)
    return {
        "candidates": [c.to_dict() for c in final],
        "report": report,
    }
