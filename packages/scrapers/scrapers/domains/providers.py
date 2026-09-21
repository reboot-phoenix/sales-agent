"""Optional contact providers — the last fallback in the enrichment cascade.

The cascade always tries free public pages first (institution/placement pages,
sitemap discovery, role-link following). Only when that yields nothing does it
ask a commercial provider, and only when the matching API key is configured.

Two rules are non-negotiable here:

* **No key, no call.** A provider without its env var is skipped, never stubbed
  with fake data.
* **No invented addresses.** A provider response is stored verbatim with
  ``contact_source=<provider>_api`` and the provider's own verification verdict.
  An address the provider will not vouch for is stored as ``unverified``; we
  never synthesise an address from a name pattern.

Providers whose HTTP contract is implemented are marked ``implemented=True``.
The rest are listed with the env var they need so an operator can see exactly
what is missing instead of assuming a capability that does not exist.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
# Generic inboxes are still useful for outreach but are tagged as such, so nobody
# mistakes info@ for a named decision maker.
GENERIC_LOCAL_PARTS = (
    "info", "contact", "hello", "admin", "office", "enquiry", "enquiries",
    "support", "help", "care", "hr", "jobs", "careers",
)
ROLE_LOCAL_PARTS = (
    "tpo", "placement", "placements", "training", "principal", "director",
    "dean", "hod", "registrar", "admissions", "dean.academics",
)
# Role signals worth keeping even when the provider returns no designation text.
_BLOCKED_LOCAL_PARTS = ("noreply", "no-reply", "postmaster", "abuse", "webmaster", "sentry", "example")


@dataclass(frozen=True)
class ProviderSpec:
    """One provider integration."""

    name: str
    env_vars: tuple[str, ...]
    implemented: bool
    docs: str
    target: str  # 'domain' | 'person'
    fetch: Optional[Callable[..., Any]] = None


def _post_json(url: str, *, json_body: dict[str, Any], headers: dict[str, str], timeout: int = 20) -> Any:
    """Thin JSON POST used by provider fetchers (isolated for testability)."""
    from ..utils.http_client import post_json

    return post_json(url, json_body=json_body, headers=headers, timeout=timeout)


def _get_json(url: str, *, headers: dict[str, str], timeout: int = 20) -> Any:
    from ..utils.http_client import get_json

    return get_json(url, headers=headers, timeout=timeout)


# --------------------------------------------------------------------------- #
# Provider fetchers
# --------------------------------------------------------------------------- #

async def _hunter_domain_search(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """Hunter.io domain search (https://hunter.io/api-documentation#domain-search)."""
    data = await _get_json(
        f"https://api.hunter.io/v2/domain-search?domain={domain}&limit={limit}&api_key={key}",
        headers={"Accept": "application/json"},
    )
    out: list[dict[str, Any]] = []
    for item in ((data or {}).get("data") or {}).get("emails") or []:
        first, last = item.get("first_name"), item.get("last_name")
        out.append({
            "full_name": " ".join(p for p in (first, last) if p) or None,
            "designation": item.get("position"),
            "email": item.get("value"),
            "verification_status": "verified" if item.get("verification", {}).get("status") == "valid" else "unverified",
            "confidence_score": int(item.get("confidence") or 0),
        })
    return out


async def _snov_domain_emails(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """Snov.io domain search."""
    client_id = os.environ.get("SNOV_CLIENT_ID", "")
    secret = os.environ.get("SNOV_CLIENT_SECRET", key)
    token = await _post_json(
        "https://api.snov.io/v1/oauth/access_token",
        json_body={"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret},
        headers={"Content-Type": "application/json"},
    )
    access = (token or {}).get("access_token")
    if not access:
        return []
    data = await _post_json(
        "https://api.snov.io/v2/domain-emails-with-info",
        json_body={"domain": domain, "type": "all", "limit": limit},
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
    )
    out: list[dict[str, Any]] = []
    for item in (data or {}).get("emails") or []:
        out.append({
            "full_name": item.get("fullName") or None,
            "designation": item.get("position"),
            "email": item.get("email"),
            "verification_status": "verified" if str(item.get("status")) == "verified" else "unverified",
            "confidence_score": int(item.get("confidence") or 0),
        })
    return out


async def _apollo_people_search(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """Apollo.io mixed people search, filtered to outreach-relevant titles."""
    data = await _post_json(
        "https://api.apollo.io/api/v1/mixed_people/search",
        json_body={
            "q_organization_domains": domain,
            "person_titles": [
                "training and placement officer", "placement officer", "placement head",
                "principal", "director", "dean", "registrar",
            ],
            "page": 1,
            "per_page": limit,
        },
        headers={"x-api-key": key, "Content-Type": "application/json"},
    )
    out: list[dict[str, Any]] = []
    for person in (data or {}).get("people") or []:
        out.append({
            "full_name": person.get("name"),
            "designation": person.get("title"),
            "email": person.get("email"),
            "phone": (person.get("phone_numbers") or [{}])[0].get("sanitized_number") if person.get("phone_numbers") else None,
            "linkedin_url": person.get("linkedin_url"),
            "verification_status": "verified" if person.get("email_status") == "verified" else "unverified",
            "confidence_score": 70 if person.get("email_status") == "verified" else 50,
        })
    return out


async def _pdl_company_enrich(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """People Data Labs company enrich — returns domain-level emails only."""
    data = await _get_json(
        f"https://api.peopledatalabs.com/v5/company/enrich?website={domain}",
        headers={"X-Api-Key": key, "Accept": "application/json"},
    )
    email = (data or {}).get("data", {}).get("email") if isinstance(data, dict) else None
    if not email or not _EMAIL_RE.match(str(email)):
        return []
    return [{"full_name": None, "designation": None, "email": email, "verification_status": "unverified", "confidence_score": 40}]


async def _prospeo_domain_search(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """Prospeo domain search."""
    data = await _post_json(
        "https://api.prospeo.io/domain-search",
        json_body={"domain": domain, "limit": limit},
        headers={"X-KEY": key, "Content-Type": "application/json"},
    )
    out: list[dict[str, Any]] = []
    for item in (data or {}).get("response", {}).get("email_list") or []:
        out.append({
            "full_name": item.get("full_name") or None,
            "designation": item.get("position"),
            "email": item.get("email"),
            "linkedin_url": item.get("linkedin_url"),
            "verification_status": "verified" if item.get("email_status") == "VERIFIED" else "unverified",
            "confidence_score": 65,
        })
    return out


async def _findymail_domain_search(domain: str, key: str, limit: int) -> list[dict[str, Any]]:
    """Findymail domain search."""
    data = await _post_json(
        "https://app.findymail.com/api/search/domain",
        json_body={"domain": domain},
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    out: list[dict[str, Any]] = []
    for item in (data or {}).get("contacts") or []:
        out.append({
            "full_name": item.get("name") or None,
            "designation": None,
            "email": item.get("email"),
            "verification_status": "verified" if item.get("verified") else "unverified",
            "confidence_score": 60,
        })
    return out


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #

PROVIDERS: dict[str, ProviderSpec] = {
    "hunter": ProviderSpec("hunter", ("HUNTER_API_KEY",), True, "https://hunter.io/api-documentation", "domain", _hunter_domain_search),
    "snov": ProviderSpec("snov", ("SNOV_CLIENT_ID", "SNOV_CLIENT_SECRET"), True, "https://snov.io/api", "domain", _snov_domain_emails),
    "apollo": ProviderSpec("apollo", ("APOLLO_API_KEY",), True, "https://docs.apollo.io/", "domain", _apollo_people_search),
    "peopledatalabs": ProviderSpec("peopledatalabs", ("PDL_API_KEY",), True, "https://docs.peopledatalabs.com/", "domain", _pdl_company_enrich),
    "prospeo": ProviderSpec("prospeo", ("PROSPEO_API_KEY",), True, "https://prospeo.io/api-docs", "domain", _prospeo_domain_search),
    "findymail": ProviderSpec("findymail", ("FINDYMAIL_API_KEY",), True, "https://www.findymail.com/docs", "domain", _findymail_domain_search),
    # Listed so operators can see what is missing; no HTTP contract is implemented
    # here, and nothing pretends otherwise.
    "rocketreach": ProviderSpec("rocketreach", ("ROCKETREACH_API_KEY",), False, "https://rocketreach.co/api", "person"),
    "lusha": ProviderSpec("lusha", ("LUSHA_API_KEY",), False, "https://www.lusha.com/docs/", "person"),
    "skrapp": ProviderSpec("skrapp", ("SKRAPP_API_KEY",), False, "https://skrapp.io/api", "domain"),
    "clearbit": ProviderSpec("clearbit", ("CLEARBIT_API_KEY",), False, "https://dashboard.clearbit.com/docs", "domain"),
    "contactout": ProviderSpec("contactout", ("CONTACTOUT_API_KEY",), False, "https://contactout.com/api", "person"),
    "wiza": ProviderSpec("wiza", ("WIZA_API_KEY",), False, "https://wiza.co/api", "domain"),
    "voilanorbert": ProviderSpec("voilanorbert", ("VOILANORBERT_API_KEY",), False, "https://www.voilanorbert.com/api/", "domain"),
}


def configured_providers() -> list[str]:
    """Providers that are implemented AND have their credentials configured."""
    ready: list[str] = []
    for name, spec in PROVIDERS.items():
        if not spec.implemented:
            continue
        if all(os.environ.get(var) for var in spec.env_vars):
            ready.append(name)
    return ready


def provider_status() -> dict[str, dict[str, Any]]:
    """Operator-facing view: what is implemented, keyed, or simply unavailable."""
    return {
        name: {
            "implemented": spec.implemented,
            "env_vars": list(spec.env_vars),
            "configured": all(os.environ.get(v) for v in spec.env_vars),
            "docs": spec.docs,
            "target": spec.target,
        }
        for name, spec in PROVIDERS.items()
    }


def classify_email(email: Optional[str]) -> Optional[str]:
    """Coarse role category from an address local part (never from a person's name)."""
    if not email or "@" not in email:
        return None
    local = email.split("@", 1)[0].lower()
    for token in ROLE_LOCAL_PARTS:
        if local.startswith(token) or local == token:
            return "tpo" if token in ("tpo", "placement", "placements", "training") else "official"
    return None


def normalize_provider_contacts(
    raw_contacts: list[dict[str, Any]],
    *,
    provider: str,
    website_domain: Optional[str],
) -> list[dict[str, Any]]:
    """Validate and tag provider output. Nothing is guessed, nothing is kept twice."""
    cleaned: list[dict[str, Any]] = []
    for item in raw_contacts:
        email = (item.get("email") or "").strip().lower() or None
        if email and (not _EMAIL_RE.match(email) or email.split("@", 1)[0] in _BLOCKED_LOCAL_PARTS):
            email = None
        # An address from a different domain than the institution's is not the
        # institution's contact — drop it rather than mis-attribute it.
        if email and website_domain and not email.endswith(f"@{website_domain.lower()}"):
            logger.debug("provider %s returned off-domain address, dropped", provider)
            email = None
        phone = (item.get("phone") or "").strip() or None
        linkedin = (item.get("linkedin_url") or "").strip() or None
        if not (email or phone or linkedin):
            continue
        status = "verified" if item.get("verification_status") == "verified" else "unverified"
        cleaned.append({
            "full_name": (item.get("full_name") or None),
            "designation": (item.get("designation") or None),
            "role_category": classify_email(email) or "other",
            "email": email,
            "phone": phone,
            "linkedin_url": linkedin,
            "verification_status": status,
            "contact_source": f"{provider}_api",
            "source_url": item.get("source_url") or (f"https://{website_domain}" if website_domain else None),
            "confidence_score": int(item.get("confidence_score") or (60 if status == "verified" else 45)),
        })
    return cleaned


async def enrich_with_providers(
    *,
    website_domain: Optional[str],
    limit: int = 10,
) -> dict[str, Any]:
    """Ask every configured provider for the institution's public contacts.

    Returns ``{"contacts": [...], "providers_used": [...], "errors": [...]}``. The
    caller persists the contacts through the normal upsert path, so provenance,
    dedup and the "never downgrade a verified contact" rule all still apply.
    """
    from .normalize import extract_domain

    domain = extract_domain(website_domain) or website_domain
    contacts: list[dict[str, Any]] = []
    used: list[str] = []
    errors: list[str] = []
    if not domain:
        return {"contacts": [], "providers_used": [], "errors": ["no domain on record"]}

    for name in configured_providers():
        spec = PROVIDERS[name]
        key = os.environ.get(spec.env_vars[0], "")
        try:
            raw = await spec.fetch(domain, key, limit)  # type: ignore[misc]
        except Exception as e:  # noqa: BLE001 - a provider outage must never fail enrichment
            logger.warning("provider %s failed for %s: %s", name, domain, e)
            errors.append(f"{name}: {str(e)[:160]}")
            continue
        tagged = normalize_provider_contacts(raw or [], provider=name, website_domain=domain)
        if tagged:
            contacts.extend(tagged)
            used.append(name)
    return {"contacts": contacts, "providers_used": used, "errors": errors}
