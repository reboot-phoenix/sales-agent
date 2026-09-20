"""
Enrichment worker: consumes enrichment_queue:requests.

Per SRS §5.2: ContactOut API first (LinkedIn-URL-first), then Snov.io fallback,
then OSINT cascade (§4.5.4). Never a dead end.

If no API keys are configured, falls back to OSINT tools (holehe, duckduckgo_search)
and marks the result with provider='osint_fallback'.

Updates:
- enrichment_log table (provider, request_payload, response_payload, credits_used, status)
- leads table (pipeline_stage -> 'enriched', hr fields updated)
- Pushes SSE event to user:redis channel
- Recomputes lead score
"""

import json
import asyncio
import logging
import os
from typing import Any

import redis.asyncio as redis
import asyncpg

from .utils.db import get_db_pool, close_db_pool
from .queue import dequeue_job, run_queue_consumer, chain_lead, requeue_or_dlq, reliable_brpop, ack, publish_event
from .api_utils.scoring_client import recompute_lead_score

from .utils.redact import redact_email

logger = logging.getLogger(__name__)

# Unified enrichment order: OSINT first (free), then paid fallbacks.
# Configurable via ENRICHMENT_ORDER="osint,snovio,contactout,apollo" without code changes.
DEFAULT_ENRICHMENT_ORDER = ["osint", "snovio", "contactout", "apollo"]


def enrichment_order() -> list[str]:
    raw = os.environ.get("ENRICHMENT_ORDER", "")
    if not raw.strip():
        return list(DEFAULT_ENRICHMENT_ORDER)
    seen: list[str] = []
    for part in raw.split(","):
        p = part.strip().lower()
        if p and p not in seen:
            seen.append(p)
    return seen or list(DEFAULT_ENRICHMENT_ORDER)


async def _provider_cooldown(redis_client: Any | None, provider: str) -> bool:
    """True when provider is in cooldown (429/circuit-open). Never raises."""
    if redis_client is None:
        return False
    try:
        return bool(await redis_client.get(f"enrich:cooldown:{provider}"))
    except Exception:  # noqa: BLE001
        return False


async def _set_provider_cooldown(redis_client: Any | None, provider: str, seconds: int) -> None:
    if redis_client is None:
        return
    try:
        await redis_client.set(f"enrich:cooldown:{provider}", "1", ex=max(1, seconds))
    except Exception:  # noqa: BLE001
        pass


def _backoff_seconds(attempt: int, retry_after: float | None = None) -> float:
    """Exponential backoff with jitter; honors Retry-After when present."""
    import random
    base = min(120.0, (2.0 ** max(0, attempt)) * 1.5)
    jitter = random.uniform(0, base * 0.25)
    wait = base + jitter
    if retry_after and retry_after > 0:
        wait = max(wait, min(300.0, retry_after + jitter))
    return wait


async def call_contactout(hr_linkedin_url: str, api_key: str) -> dict[str, Any] | None:
    """Call ContactOut API with LinkedIn URL. Returns extracted contact data or None."""
    import httpx

    # Verified live: api.contactout.com returns HTTP 404 with an HTML page for
    # every path tried (/v3/linkedin, /api/v1/search, /v1/profile), and
    # api.contactout.me does not resolve -- ContactOut ships a browser extension
    # and a private dashboard API, not a documented public REST endpoint. So this
    # call cannot be made to work by fixing a URL; keep it honest instead of
    # pretending. Override CONTACTOUT_API_URL once a real endpoint/token is issued.
    url = os.environ.get("CONTACTOUT_API_URL", "https://api.contactout.com/v3/linkedin")
    params = {"profile:linkedin": hr_linkedin_url}
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code == 429:
                # Rate-limited: back off with jitter, do NOT hammer. Caller moves
                # to the next fallback provider; cooldown prevents immediate retry.
                retry_after: float | None = None
                try:
                    retry_after = float(resp.headers.get("retry-after", "") or 0) or None
                except (TypeError, ValueError):
                    retry_after = None
                logger.warning(f"ContactOut 429 rate-limited; backing off {_backoff_seconds(1, retry_after):.1f}s")
                await asyncio.sleep(_backoff_seconds(1, retry_after))
                return None
            if resp.status_code != 200:
                logger.warning(
                    f"ContactOut returned {resp.status_code} from {url} "
                    "(no public REST API is published for this vendor)"
                )
                return None
            if "json" not in resp.headers.get("content-type", ""):
                # An HTML body here means we hit a marketing 404 page, not an API.
                logger.warning("ContactOut replied with non-JSON; endpoint is not an API")
                return None
            data = resp.json()
            return {
                "hr_name": data.get("full_name", ""),
                "hr_email": data.get("email", ""),
                "hr_mobile": data.get("phone", ""),
                "hr_linkedin_url": hr_linkedin_url,
                "confidence_score": 90,
                "source": "contactout",
            }
    except Exception as e:
        logger.error(f"ContactOut API error: {e}")
        return None


async def call_snovio(hr_name: str, company_name: str, company_domain: str, api_key: str, api_secret: str | None = None) -> dict[str, Any] | None:
    """Call Snov.io email finder API. Returns extracted contact data or None."""
    import httpx

    # Verified live: v1/get-emails-from-names exists (403 without entitlement),
    # while the previously coded v2/lead-enrichment returns 404 "url or entity not
    # found" -- it does not exist, so every call failed regardless of the key.
    # Snov authenticates with access_token as a query param, not a bearer header.
    url = "https://api.snov.io/v1/get-emails-from-names"
    first, _, last = hr_name.partition(" ")
    params = {
        "firstName": first,
        "lastName": last or first,
        "companyName": company_name,
        "domain": company_domain,
        "type": "all",
        "access_token": api_key,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 429:
                retry_after: float | None = None
                try:
                    retry_after = float(resp.headers.get("retry-after", "") or 0) or None
                except (TypeError, ValueError):
                    retry_after = None
                logger.warning(f"Snov.io 429 rate-limited; backing off {_backoff_seconds(1, retry_after):.1f}s")
                await asyncio.sleep(_backoff_seconds(1, retry_after))
                return None
            if resp.status_code != 200:
                # 403 means the account lacks the Email Finder entitlement; say so
                # instead of logging a bare status the operator cannot act on.
                detail = ""
                try:
                    detail = str(resp.json().get("errors", {}).get("title", ""))[:120]
                except Exception:  # noqa: BLE001
                    pass
                logger.warning(f"Snov.io returned {resp.status_code}{f': {detail}' if detail else ''}")
                return None
            body = resp.json()
            emails = body.get("emails", [])
            if emails:
                return {
                    "hr_name": hr_name,
                    "hr_email": emails[0].get("email", ""),
                    "hr_linkedin_url": "",
                    "confidence_score": 70,
                    "source": "snovio",
                }
    except Exception as e:
        logger.error(f"Snov.io API error: {e}")
        return None
    return None


async def run_osint_enrichment(
    db_pool: asyncpg.Pool,
    company_name: str,
    hr_name: str,
    company_domain: str,
    api_keys: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """OSINT cascade per SRS §4.5.4 — free/public sources first, then (only if the
    record is STILL missing a contact) a per-vendor paid waterfall gated on the
    keys actually configured. Never spends a credit when free data suffices."""
    result: dict[str, Any] = {"source": "osint_fallback", "confidence_score": 30}

    # Tier 1: Verified LinkedIn profile resolution — dork for candidates, READ
    # each public profile via Jina reader, and only accept when the profile's own
    # name matches the target (difflib gate) with company corroboration.
    # Replaces the old "first linkedin.com/in hit" which happily attached a
    # same-named stranger (never-fabricate golden rule, SRS §6.2).
    if hr_name:
        try:
            from .utils.linkedin_osint import resolve_linkedin_profile
            prof = await resolve_linkedin_profile(hr_name, company_name)
            if prof.get("linkedin"):
                result["hr_linkedin_url"] = prof["linkedin"]
                if not result.get("hr_name") and prof.get("name"):
                    result["hr_name"] = prof["name"]
                # confidence_score is 0..100 here; prof confidence is 0..1
                result["confidence_score"] = max(
                    result["confidence_score"], 20 + int(prof["confidence"] * 80)
                )
                logger.info(
                    f"OSINT: verified LinkedIn {prof['linkedin']} "
                    f"(conf {prof['confidence']}, {prof['source']})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"LinkedIn OSINT resolve failed for {hr_name}@{company_name}: {e}")

    # Tier 2: Generic company contact patterns
    domain = company_domain or company_name.lower().replace(" ", "")

    # Tier 0: hiring-team discovery — most scraped fresher leads arrive with NO hr
    # name, and every tier below gates on one, so a nameless lead used to leave
    # with nothing. Ask the company-HR extractor (ATS APIs, career pages, dorks;
    # sqlite-cached per company) who hires there; the discovered name then flows
    # through the exact same verified tiers below instead of a separate path.
    if not hr_name and company_name:
        try:
            import asyncio as _asyncio
            from .utils.company_hr_extractor import extract_hr_for_company
            found = await _asyncio.wait_for(
                extract_hr_for_company(company_name, domain, ""), timeout=75,
            )
            if found.get("hr_name"):
                hr_name = found["hr_name"]
                result["hr_name"] = hr_name
                result["method"] = f"hiring_team:{found.get('source', 'ats_career_dork')}"
                try:
                    found_conf = float(found.get("confidence", 0.5))
                except (TypeError, ValueError):
                    found_conf = 0.5
                result["confidence_score"] = max(
                    result["confidence_score"], min(70, 30 + int(found_conf * 40))
                )
                logger.info(f"OSINT: hiring-team discovery found {hr_name} @ {company_name}")
            for key, out in (("hr_email", "hr_email"), ("hr_linkedin", "hr_linkedin_url")):
                if found.get(key) and not result.get(out):
                    result[out] = found[key]
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Hiring-team discovery failed for {company_name}: {e}")

    # Email cascade. GitHub public-commit mining is the best FIRST-PARTY source:
    # a company's public repos expose real staff emails (name + @domain). We fetch
    # those ONCE, then use them two ways:
    #   (a) a direct name-match on a real commit author is our strongest signal
    #       (first-party, self-published), and
    #   (b) even without a person-match, those real addresses are fed to
    #       osint_find_email as `known_company_emails`, so it INFERS the company's
    #       actual local-part pattern instead of guessing blind (SRS §6.1).
    known_company_emails: list[str] = []
    if hr_name and domain:
        try:
            from .utils.github_email_osint import github_company_contacts
            from .utils.linkedin_osint import name_similarity
            gh = await github_company_contacts(domain)
            known_company_emails = gh.get("emails", []) or []
            best, best_sim = None, 0.0
            for c in gh.get("contacts", []):
                sim = name_similarity(hr_name, c.get("name", ""))
                if sim > best_sim:
                    best_sim, best = sim, c
            if best and best_sim >= 0.72:
                result["hr_email"] = best["email"]
                result["method"] = "github_commit_verified"
                result["confidence_score"] = max(result["confidence_score"], 30 + int(0.9 * 40))
                logger.info(f"OSINT: GitHub-verified email {redact_email(best['email'])}")
            elif gh.get("pattern"):
                logger.info(f"OSINT: GitHub learned pattern {gh['pattern']!r} for {domain}")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"GitHub email mining failed for {redact_email(hr_name)}@{domain}: {e}")

    # Pattern-guess fallback (learns real format from known_company_emails above).
    if hr_name and domain and not result.get("hr_email"):
        try:
            from .utils.osint import osint_find_email
            found = await osint_find_email(hr_name, domain, known_company_emails=known_company_emails)
            if found.get("email"):
                result["hr_email"] = found["email"]
                result["method"] = found["method"]
                # 30 (base) + confidence*40 → 0.8→62, 0.7→58, 0.5→50
                result["confidence_score"] = max(
                    result["confidence_score"], 30 + int(found["confidence"] * 40)
                )
                logger.info(
                    f"OSINT: email pattern {found['email']} "
                    f"(conf {found['confidence']}, {found['method']})"
                )
        except Exception as e:
            logger.warning(f"OSINT email discovery failed for {redact_email(hr_name)}@{domain}: {e}")

    # Tier 2a-fallback: multi-engine SERP email-exposure dorking — a published
    # `name@company.com` in an indexed page (roster/PDF/directory) beats a
    # generated-and-MX-confirmed guess. Only tried if nothing above matched.
    if hr_name and domain and not result.get("hr_email"):
        try:
            from .utils.serp_dork import dork_find_email
            sd = await dork_find_email(hr_name, company_name, domain)
            if sd.get("email"):
                result["hr_email"] = sd["email"]
                result["method"] = sd["method"]
                result["confidence_score"] = max(
                    result["confidence_score"], 30 + int(sd["confidence"] * 40)
                )
                logger.info(
                    f"OSINT: SERP-exposed email {sd['email']} (conf {sd['confidence']})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"SERP email dork failed for {redact_email(hr_name)}@{domain}: {e}")

    # Tier 2b: cert-transparency (crt.sh) + Wayback archival harvest — both key-
    # free public OSINT. crt.sh leaks addresses from cert subjects/SANs and often
    # reveals extra subdomains; Wayback recovers HR emails from *rotated/archived*
    # careers pages that 404 today. Two uses: (a) feed these real addresses into
    # the pattern-inference set, (b) a direct name-match is first-party-ish proof.
    if domain and domain != ".com":
        harvested: list[str] = []
        try:
            from .utils.osint_contacts import crtsh_emails, wayback_emails
            harvested += await crtsh_emails(domain)
            for path in (f"https://www.{domain}/careers", f"https://{domain}/careers"):
                harvested += await wayback_emails(path)
                if harvested:
                    break
        except Exception as e:  # noqa: BLE001
            logger.debug(f"OSINT email harvest skipped for {domain}: {e}")
        harvested = [e for e in harvested if e and "@" in e]
        # (a) enrich the pattern-inference corpus with any new real addresses
        known_company_emails = list(dict.fromkeys(known_company_emails + harvested))
        # (b) direct name-match on a leaked/archived address
        if hr_name and harvested and not result.get("hr_email"):
            try:
                from .utils.linkedin_osint import name_similarity
                for em in harvested:
                    local = em.split("@")[0].replace(".", " ").replace("_", " ").replace("-", " ")
                    # require the whole-name tokens to align, not a single letter
                    if name_similarity(hr_name, local) >= 0.72:
                        result["hr_email"] = em
                        result["method"] = "osint_archive_crtsh"
                        result["confidence_score"] = max(result["confidence_score"], 58)
                        logger.info(f"OSINT: crt.sh/Wayback matched {em}")
                        break
            except Exception as e:  # noqa: BLE001
                logger.debug(f"crt.sh/Wayback name-match skipped: {e}")

    generic_emails = [
        f"careers@{domain}.com",
        f"hr@{domain}.com",
        f"jobs@{domain}.com",
        f"recruiting@{domain}.com",
    ]

    # Tier 2c: Gravatar — a free existence+identity oracle for any email we found.
    # A Gravatar profile means the mailbox is real (Google/WordPress verify on
    # signup) and often carries the person's real display name. Used to LIFT
    # confidence and recover a name, never to fabricate an address.
    if result.get("hr_email"):
        try:
            from .utils.osint_contacts import gravatar_lookup
            g = await asyncio.to_thread(gravatar_lookup, result["hr_email"])
            if g.get("verified_email"):
                result["email_exists"] = True
                result["gravatar_photo"] = g.get("gravatar_photo", "")
                if g.get("hr_name") and not result.get("hr_name"):
                    result["hr_name"] = g["hr_name"]
                result["confidence_score"] = min(95, max(result["confidence_score"], 60) + 10)
                logger.info(f"OSINT: Gravatar confirms {redact_email(result['hr_email'])} (+10 conf)")
        except Exception as e:  # noqa: BLE001
            logger.debug(f"Gravatar lookup skipped: {e}")

    # Tier 2d: RSS hiring-signal corroboration (Agent-Reach channel port,
    # stdlib-only). Reads the company's OWN press/blog feeds for hiring
    # announcements. Signals ONLY — never contacts. Corroborates active hiring
    # for draft grounding and the enrichment provenance log.
    if domain and domain != ".com":
        try:
            from .utils.rss_signals import fetch_company_hiring_signals
            rss = await fetch_company_hiring_signals(company_name, domain)
            if rss.get("signals"):
                result["hiring_signals"] = rss["signals"]
                logger.info(
                    f"OSINT: {len(rss['signals'])} RSS hiring signal(s) "
                    f"for {company_name} ({rss.get('feeds_checked', 0)} feeds)"
                )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"RSS signals skipped for {company_name}@{domain}: {e}")

    # Tier 3: holehe check on company emails
    for email in generic_emails:
        try:
            from .normalizer import run_holehe_check
            holehe_result = await run_holehe_check(email)
            if holehe_result.get("valid"):
                result["company_email"] = email
                # only fall back to a generic inbox as the personal email if the
                # targeted cascade found nothing — never clobber a verified addr.
                if not result.get("hr_email"):
                    result["hr_email"] = email
                result["confidence_score"] = max(result["confidence_score"], 55)
                logger.info(f"OSINT: holehe validated {redact_email(email)}")
                break
        except Exception as e:  # noqa: BLE001
            logger.warning(f"holehe check failed for {redact_email(email)}: {e}")

    # Tier 4 (last resort): PAID waterfall — only when every free tier above
    # failed to find a personal email, and only vendors whose key is configured.
    # Runs cheapest-first and stops at the first hit, so a record costs at most
    # one credit. §6.3: vendor confidence/verified flags are carried through.
    if hr_name and domain and not result.get("hr_email") and (api_keys or _env_vendor_keys()):
        try:
            from .utils.email_providers import paid_email_waterfall
            paid = await paid_email_waterfall(hr_name, domain, api_keys or {})
            if paid.get("hr_email"):
                result["hr_email"] = paid["hr_email"]
                if paid.get("hr_name") and not result.get("hr_name"):
                    result["hr_name"] = paid["hr_name"]
                if paid.get("hr_linkedin_url") and not result.get("hr_linkedin_url"):
                    result["hr_linkedin_url"] = paid["hr_linkedin_url"]
                result["method"] = f"paid_{paid.get('source', 'vendor')}"
                result["source"] = paid.get("source", "paid")
                result["paid_credits"] = int(paid.get("credits", 1))
                # email_providers adapters already report confidence on a 0..100
                # scale (Apollo verified=90, findymail safe=85, ...). Do NOT rescale
                # — clamp. (A prior `* 90` here produced 8100, which defeated the
                # §6.3 no-clobber UPDATE guard and let a paid guess overwrite a
                # verified email.)
                conf = max(0, min(100, int(paid.get("confidence", 60))))
                if paid.get("verified"):
                    conf = max(conf, 85)
                result["confidence_score"] = max(result["confidence_score"], conf)
                logger.info(
                    f"PAID {paid.get('source')}: {paid['hr_email']} "
                    f"(verified={paid.get('verified')})"
                )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Paid email waterfall failed for {redact_email(hr_name)}@{domain}: {e}")

    return result


def _env_vendor_keys() -> dict[str, str]:
    """Any email-vendor API key present in the environment (module-level fallback)."""
    keys = {}
    for env, slug in (
        ("HUNTER_API_KEY", "hunter"), ("APOLLO_API_KEY", "apollo_io"),
        ("FINDYMAIL_API_KEY", "findymail"), ("PROSPEO_API_KEY", "prospeo"),
        ("LUSHA_API_KEY", "lusha"), ("ROCKETREACH_API_KEY", "rocketreach"),
    ):
        if os.environ.get(env):
            keys[slug] = os.environ[env]
    return keys


async def run_enrichment_cascade(
    db_pool, provider, company_name, company_domain, hr_name, hr_linkedin, api_keys,
) -> tuple[dict[str, Any] | None, str, int, str]:
    """Vendor + OSINT cascade, deliberately run with NO pooled DB connection held.

    This phase issues outbound calls to crt.sh, search engines and Snov.io, each
    carrying a 30s timeout. Holding one of ~15 asyncpg pool connections across it
    let a few slow vendor responses starve every other consumer and stall the whole
    pipeline, so process_enrichment_job releases the connection before calling this
    and re-acquires afterwards for the writes.

    Returns (enrichment_result, used_provider, credits_used, status).
    """
    enrichment_result: dict[str, Any] | None = None
    used_provider = "osint_fallback"
    credits_used = 0
    status = "success"

    # Unified fallback order: OSINT → Snov → ContactOut → Apollo.
    # Free first, paid ONLY for records still missing a contact, per-record.
    # provider="auto" walks enrichment_order(); an explicit provider runs only itself.
    contactout_key_missing = False
    snovio_key_missing = False
    order = [provider] if provider not in ("auto",) else enrichment_order()

    async def _run_step(step: str) -> None:
        nonlocal enrichment_result, used_provider, credits_used, status
        nonlocal contactout_key_missing, snovio_key_missing
        if enrichment_result and enrichment_result.get("hr_email"):
            return  # field-level short-circuit: email already verified, skip paid spend
        if step in ("osint", "osint_fallback"):
            enrichment_result = await run_osint_enrichment(
                db_pool, company_name, hr_name, company_domain, api_keys
            )
            used_provider = enrichment_result.get("method") or enrichment_result.get(
                "source", "osint_fallback")
            credits_used = int(enrichment_result.get("paid_credits", 0))
        elif step == "snovio":
            snovio_key = api_keys.get("snovio") or os.environ.get("SNOVIO_API_KEY")
            snovio_secret = api_keys.get("snovio_secret") or os.environ.get("SNOVIO_API_SECRET")
            if provider == "snovio" and not snovio_key:
                snovio_key_missing = True
            if snovio_key and hr_name and company_name:
                result = await call_snovio(hr_name, company_name, company_domain, snovio_key, snovio_secret)
                if result:
                    # Field-level merge: never overwrite a stronger verified value
                    # with a weaker one — only fill missing fields.
                    base = dict(enrichment_result or {})
                    for k, v in result.items():
                        if k in ("hr_email", "hr_mobile", "hr_name", "hr_linkedin_url"):
                            if not base.get(k) and v:
                                base[k] = v
                        else:
                            base.setdefault(k, v)
                    base.setdefault("provenance", {}).update({k: "snovio" for k in result if result.get(k)})
                    enrichment_result = base
                    used_provider = "snovio"
                    credits_used = 1
                    status = "success"
        elif step == "contactout":
            contactout_key = (
                api_keys.get("contactout")
                or os.environ.get("CONTACT_OUT_API_KEY")
                or os.environ.get("ACCONTACT_OUT_API_KEY")  # legacy alias, kept for compat
                or os.environ.get("ACCONTOUT_API_KEY")
            )
            if provider == "contactout" and not contactout_key:
                contactout_key_missing = True
            if contactout_key and hr_linkedin:
                result = await call_contactout(hr_linkedin, contactout_key)
                if result:
                    base = dict(enrichment_result or {})
                    for k, v in result.items():
                        if k in ("hr_email", "hr_mobile", "hr_name", "hr_linkedin_url"):
                            if not base.get(k) and v:
                                base[k] = v
                        else:
                            base.setdefault(k, v)
                    base.setdefault("provenance", {}).update({k: "contactout" for k in result if result.get(k)})
                    enrichment_result = base
                    used_provider = "contactout"
                    credits_used = 1
                    status = "success"

    for _step in order:
        if _step in ("osint", "osint_fallback", "snovio", "contactout"):
            await _run_step(_step)
    # Apollo / other paid vendors remain fallbacks (auto includes them when no
    # email yet); explicit single-provider override handled below.

    # Apollo + other paid vendors: explicit override, or auto-fallback steps
    # (in enrichment_order()) when everything above found no email.
    _fallback_vendors = ("apollo", "apollo_io", "hunter", "lusha", "rocketreach", "prospeo", "findymail")
    _wanted: list[str] = []
    if provider in _fallback_vendors:
        _wanted = [provider]
    elif provider == "auto":
        _wanted = [s for s in order if s in _fallback_vendors]
        if not enrichment_result or not enrichment_result.get("hr_email"):
            _wanted = _wanted or (["apollo"] if "apollo" in enrichment_order() or True else [])
            # Default apollo fallback even when order omits vendors: graceful,
            # skipped without a key.
            if "apollo" not in _wanted:
                _wanted = ["apollo"]
    if _wanted and (not enrichment_result or not enrichment_result.get("hr_email")):
        try:
            from .utils.email_providers import enrich_via_apollo_io, enrich_via_hunter, enrich_via_lusha, enrich_via_rocketreach, enrich_via_prospeo, enrich_via_findymail
            _single_map = {
                "hunter": enrich_via_hunter, "apollo": enrich_via_apollo_io,
                "apollo_io": enrich_via_apollo_io, "lusha": enrich_via_lusha,
                "rocketreach": enrich_via_rocketreach, "prospeo": enrich_via_prospeo,
                "findymail": enrich_via_findymail,
            }
            for _name in _wanted:
                _single = _single_map.get(_name)
                if not _single:
                    continue
                try:
                    r = await _single(hr_name, company_domain, api_keys.get(_name))
                except TypeError:
                    # 429-backed-off adapters may raise; treat as miss, keep chain alive.
                    logger.warning(f"provider {_name} errored; continuing fallback")
                    continue
                if r and r.get("hr_email"):
                    base = dict(enrichment_result or {})
                    for k, v in r.items():
                        if k in ("hr_email", "hr_mobile", "hr_name", "hr_linkedin_url"):
                            if not base.get(k) and v:
                                base[k] = v
                        else:
                            base.setdefault(k, v)
                    enrichment_result = base
                    used_provider = _name
                    credits_used = 1
                    status = "success"
                    break
        except Exception as e:  # noqa: BLE001
            logger.warning(f"fallback vendors { _wanted} failed: {e}")

    if enrichment_result is None or (
        not enrichment_result.get("hr_email")
        and not enrichment_result.get("hr_linkedin_url")
    ):
        # Explicit per-row provider choice must be recorded honestly: the
        # operator chose X and X produced nothing (missing key vs API miss
        # distinguished so the UI can say "configure a key" vs "no match").
        if provider not in ("auto", "osint", "osint_fallback"):
            used_provider = provider
            key_missing = (
                (provider == "contactout" and contactout_key_missing)
                or (provider == "snovio" and snovio_key_missing)
                or (
                    provider not in ("contactout", "snovio")
                    and not api_keys.get(provider)
                    and not any(
                        os.environ.get(e) for e in {
                            "hunter": ["HUNTER_API_KEY"],
                            "apollo": ["APOLLO_API_KEY"],
                            "apollo_io": ["APOLLO_API_KEY"],
                            "lusha": ["LUSHA_API_KEY"],
                            "rocketreach": ["ROCKETREACH_API_KEY"],
                            "prospeo": ["PROSPEO_API_KEY"],
                            "findymail": ["FINDYMAIL_API_KEY"],
                        }.get(provider, [])
                    )
                )
            )
            status = "provider_not_configured" if key_missing else "no_match"
        else:
            status = "no_match"

    return enrichment_result, used_provider, credits_used, status


def _as_list(value: Any) -> list:
    """Normalize a JSONB column to a list. Legacy rows may hold a bare scalar
    string (or NULL) where a list is expected — concatenating those raised
    `TypeError: can only concatenate str (not "list")` and left the enrichment
    job stuck at 'running' forever (seen live 2026-09-20)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _merge_lists(old: Any, new: Any) -> list:
    """Dedupe-preserving merge for JSONB array columns (emails, phones, tech)."""
    seen: list = []
    for v in _as_list(old) + _as_list(new):
        if v and v not in seen:
            seen.append(v)
    return seen


def _merge_dicts(old: Any, new: Any) -> dict:
    base = dict(old or {})
    base.update(new or {})
    return base


def collect_person_fields(result: dict[str, Any]) -> dict[str, Any]:
    """Every person field the cascade/providers found, mapped to hr_contacts columns."""
    extra_phones = [p for p in (result.get("extra_phones") or []) if p]
    return {
        "full_name": result.get("hr_name", "") or "",
        "linkedin_url": result.get("hr_linkedin_url", "") or "",
        "personal_email": result.get("hr_email", "") or "",
        "personal_mobile": result.get("hr_mobile", "") or "",
        "job_title": result.get("person_title", "") or "",
        "department": result.get("person_department", "") or "",
        "seniority": result.get("person_seniority", "") or "",
        "location": result.get("person_location", "") or "",
        "phones": extra_phones,
        "email_verified": bool(result.get("email_verified") or result.get("verified")),
        "socials": {k: v for k, v in {
            "twitter": result.get("person_twitter", ""),
            "github": result.get("person_github", ""),
        }.items() if v},
    }


def collect_company_fields(result: dict[str, Any]) -> dict[str, Any]:
    """Every company field the cascade/providers found, mapped to companies columns."""
    tech = [t for t in (result.get("company_tech") or []) if t]
    return {
        "employee_count": result.get("company_employee_count"),
        "revenue": result.get("company_revenue", "") or "",
        "founded_year": result.get("company_founded"),
        "tech_stack": tech,
        "linkedin_url": result.get("company_linkedin_url", "") or "",
        "industry": result.get("company_industry", "") or "",
    }


def collect_provenance(result: dict[str, Any], used_provider: str) -> dict[str, Any]:
    """Per-field { source, verified, at }: which provider gave us each fact."""
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    prov = dict(result.get("provenance") or {})
    verified = bool(result.get("verified"))
    for key in ("full_name", "linkedin_url", "personal_email", "personal_mobile",
                "job_title", "department", "seniority", "location"):
        if result.get({
            "full_name": "hr_name", "linkedin_url": "hr_linkedin_url",
            "personal_email": "hr_email", "personal_mobile": "hr_mobile",
            "job_title": "person_title", "department": "person_department",
            "seniority": "person_seniority", "location": "person_location",
        }[key]) and key not in prov:
            prov[key] = {"source": used_provider, "verified": verified, "at": now}
    return prov


async def process_enrichment_job(
    payload: dict[str, Any],
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool,
) -> None:
    """Process a single enrichment job from the queue."""
    lead_id = payload.get("lead_id")
    provider = payload.get("provider", "auto")
    requested_by = payload.get("requested_by", "system")
    requested_at = payload.get("requested_at", "")

    if not lead_id:
        logger.error("Enrichment job missing lead_id")
        return

    logger.info(f"Processing enrichment for lead {lead_id}, provider={provider}")
    job_id = payload.get("job_id")

    async def _mark_job(conn: Any, status: str, stage: str, error: Any = None, summary: Any = None) -> None:
        # enrichment_jobs may not exist on old DBs; never let telemetry break the pipeline.
        try:
            if job_id:
                await conn.execute(
                    """UPDATE enrichment_jobs SET status=$2, current_stage=$3,
                       attempts=attempts+1, error=$4, result_summary=$5, updated_at=NOW()
                       WHERE id=$1""",
                    job_id, status, stage,
                    json.dumps(error) if error is not None else None,
                    json.dumps(summary) if summary is not None else None,
                )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"enrichment_jobs update skipped: {e}")

    async with db_pool.acquire() as conn:
        if job_id:
            try:
                await conn.execute(
                    "UPDATE enrichment_jobs SET status='running', current_stage='running', updated_at=NOW() WHERE id=$1",
                    job_id,
                )
            except Exception as e:  # noqa: BLE001
                logger.debug(f"enrichment_jobs running-mark skipped: {e}")
        lead = await conn.fetchrow(
            """
            SELECT l.id, l.hr_contact_id, l.pipeline_stage, l.company_id,
                   hc.full_name, hc.linkedin_url, hc.personal_email, hc.personal_mobile,
                   hc.current_company_id as contact_company_id,
                   c.name as company_name, c.domain
            FROM leads l
            JOIN companies c ON l.company_id = c.id
            LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
            WHERE l.id = $1
            -- Lock only the leads row we mutate. `FOR UPDATE` over the whole
            -- query is illegal because hr_contacts is on the nullable side of
            -- the LEFT JOIN (`FOR UPDATE cannot be applied to the nullable side
            -- of an outer join`).
            FOR UPDATE OF l
            """,
            lead_id,
        )

        if not lead:
            logger.warning(f"Lead not found: {lead_id}")
            return

        # The HR name lives on the joined hr_contacts row (the normalizer never
        # stores it on leads). Empty until a contact is attached — the cascade
        # then infers/looks it up by company + any name we discover.
        hr_name = lead["full_name"] or ""
        company_name = lead["company_name"] or ""
        company_domain = lead["domain"] or ""
        hr_linkedin = lead["linkedin_url"] or ""

        # `requested_by` is a UUID FK to users for manual runs, but scheduled
        # runs pass sentinels like "system"/"daily_scheduler". Coerce to a real
        # UUID (or None) so neither the users lookup nor the enrichment_log
        # FK insert dies on a non-UUID string.
        # Requesting user (None for automated runs) plus their vendor keys; falls
        # back to the key-owning account so scheduled jobs use paid providers too.
        from .utils.job_keys import resolve_job_user
        user_id, api_keys = await resolve_job_user(conn, requested_by)

    # Connection released at the end of the read block above; the cascade makes
    # no use of it, and the write block below re-acquires.
    try:
        enrichment_result, used_provider, credits_used, status = await run_enrichment_cascade(
            db_pool, provider, company_name, company_domain, hr_name, hr_linkedin, api_keys,
        )
    except Exception as e:  # noqa: BLE001
        # The job row must never stick at running: record the failure so the UI
        # is honest, then re-raise so the queue redrives/DLQs normally.
        async with db_pool.acquire() as conn:
            await _mark_job(conn, "failed", "cascade_error",
                            error={"error": str(e)[:500], "provider": provider})
        raise

    person = collect_person_fields(enrichment_result or {})
    company = collect_company_fields(enrichment_result or {})
    confidence = (enrichment_result or {}).get("confidence_score", 0)
    # Locator rule mirrors hr_contacts_has_locator: a contact row needs at
    # least one real way to reach the person. Name-only findings must NOT be
    # inserted (used to crash on the CHECK and retry 5x into the DLQ).
    has_locator = bool(person["personal_email"] or person["personal_mobile"] or person["linkedin_url"])
    # M7: LinkedIn alone is locatable but NOT contactable. The 'enriched'
    # stage requires an email or phone; LinkedIn-only leads go to
    # 'contact_unavailable' instead of sitting 'enriched' forever with no
    # channel to verify/send on.
    has_contactable = bool(person["personal_email"] or person["personal_mobile"])

    try:
        async with db_pool.acquire() as conn:
            # Update enrichment_log
            await conn.execute(
                """
                INSERT INTO enrichment_log
                  (lead_id, provider, requested_by, request_payload, response_payload, credits_used, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                lead_id,
                used_provider,
                user_id,                       # NULL for scheduled/sentinel runs
                json.dumps({"provider": provider, "requested_at": requested_at}),
                json.dumps(enrichment_result or {}),
                credits_used,
                status,
            )

            # Update HR contact / lead — full person record, never clobbering a
            # stronger verified value with a weaker one (confidence-gated).
            if has_locator:
                prov = collect_provenance(enrichment_result or {}, used_provider)
                # Only trust the lead's existing link when it actually belongs to
                # this lead's company. Legacy rows carry a contact that was matched
                # globally (a recruiter from an unrelated employer); updating that
                # row would overwrite a real person's details with someone else's,
                # so re-point the lead at a correctly-scoped contact instead.
                if lead["hr_contact_id"] and lead["contact_company_id"] == lead["company_id"]:
                    cur = await conn.fetchrow(
                        """SELECT personal_email, personal_mobile, emails, phones,
                                  socials, field_provenance, email_verified
                           FROM hr_contacts WHERE id = $1""",
                        lead["hr_contact_id"],
                    )
                    curd = dict(cur) if cur else {}
                    merged_emails = _merge_lists(curd.get("emails"), [person["personal_email"]])
                    merged_phones = _merge_lists(
                        _merge_lists(curd.get("phones"), [person["personal_mobile"]]),
                        person["phones"],
                    )
                    await conn.execute(
                        """
                        UPDATE hr_contacts
                        SET full_name = COALESCE(NULLIF(full_name, ''), NULLIF($1, '')),
                            linkedin_url = CASE
                                WHEN linkedin_url IS NULL OR linkedin_url = ''
                                     OR $11 > confidence_score
                                THEN COALESCE(NULLIF($2, ''), linkedin_url) ELSE linkedin_url END,
                            personal_email = CASE
                                WHEN personal_email IS NULL OR personal_email = ''
                                     OR $11 > confidence_score
                                THEN COALESCE(NULLIF($3, ''), personal_email) ELSE personal_email END,
                            personal_mobile = CASE
                                WHEN personal_mobile IS NULL OR personal_mobile = ''
                                     OR $11 > confidence_score
                                THEN COALESCE(NULLIF($4, ''), personal_mobile) ELSE personal_mobile END,
                            job_title = COALESCE(NULLIF(job_title, ''), NULLIF($5, '')),
                            department = COALESCE(NULLIF(department, ''), NULLIF($6, '')),
                            seniority = COALESCE(NULLIF(seniority, ''), NULLIF($7, '')),
                            location = COALESCE(NULLIF(location, ''), NULLIF($8, '')),
                            emails = $9::jsonb,
                            phones = $10::jsonb,
                            email_verified = email_verified OR $12,
                            socials = socials || $13::jsonb,
                            field_provenance = field_provenance || $14::jsonb,
                            confidence_score = GREATEST(confidence_score, $11),
                            updated_at = NOW()
                        WHERE id = $15
                        """,
                        person["full_name"] or None,
                        person["linkedin_url"] or None,
                        person["personal_email"] or None,
                        person["personal_mobile"] or None,
                        person["job_title"] or None,
                        person["department"] or None,
                        person["seniority"] or None,
                        person["location"] or None,
                        json.dumps(merged_emails),
                        json.dumps(merged_phones),
                        confidence,
                        person["email_verified"],
                        json.dumps(person["socials"]),
                        json.dumps(prov),
                        lead["hr_contact_id"],
                    )
                else:
                    hr_id = await conn.fetchval(
                        """
                        INSERT INTO hr_contacts
                          (full_name, linkedin_url, personal_email, personal_mobile,
                           job_title, department, seniority, location, emails, phones,
                           email_verified, socials, field_provenance,
                           current_company_id, confidence_score)
                        VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''),
                                NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
                                $9::jsonb, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15)
                        RETURNING id
                        """,
                        person["full_name"] or None,
                        person["linkedin_url"] or None,
                        person["personal_email"] or None,
                        person["personal_mobile"] or None,
                        person["job_title"] or None,
                        person["department"] or None,
                        person["seniority"] or None,
                        person["location"] or None,
                        json.dumps(_merge_lists([], [person["personal_email"]])),
                        json.dumps(_merge_lists([person["personal_mobile"]], person["phones"])),
                        person["email_verified"],
                        json.dumps(person["socials"]),
                        json.dumps(prov),
                        lead["company_id"],
                        confidence,
                    )
                    await conn.execute(
                        "UPDATE leads SET hr_contact_id = $1 WHERE id = $2",
                        hr_id,
                        lead_id,
                    )

            # Company firmographics: fill only what is unknown, merge tech/provenance.
            if any([company["employee_count"], company["revenue"], company["founded_year"],
                    company["tech_stack"], company["linkedin_url"], company["industry"]]):
                cur_co = await conn.fetchrow(
                    """SELECT employee_count, revenue, founded_year, tech_stack,
                              linkedin_url, industry, field_provenance
                       FROM companies WHERE id = $1""",
                    lead["company_id"],
                )
                if cur_co:
                    cod = dict(cur_co)
                    import datetime as _dt
                    now_iso = _dt.datetime.now(_dt.timezone.utc).isoformat()
                    co_prov = dict(cod.get("field_provenance") or {})
                    for k in ("employee_count", "revenue", "founded_year", "tech_stack",
                              "linkedin_url", "industry"):
                        if company.get(k) and k not in co_prov:
                            co_prov[k] = {"source": used_provider, "at": now_iso}
                    await conn.execute(
                        """UPDATE companies
                           SET employee_count = COALESCE(employee_count, $1),
                               revenue = COALESCE(NULLIF(revenue, ''), NULLIF($2, '')),
                               founded_year = COALESCE(founded_year, $3),
                               tech_stack = $4::jsonb,
                               linkedin_url = COALESCE(NULLIF(linkedin_url, ''), NULLIF($5, '')),
                               industry = COALESCE(NULLIF(industry, ''), NULLIF($6, '')),
                               field_provenance = field_provenance || $7::jsonb,
                               updated_at = NOW()
                           WHERE id = $8""",
                        company["employee_count"],
                        company["revenue"] or None,
                        company["founded_year"],
                        json.dumps(_merge_lists(cod.get("tech_stack"), company["tech_stack"])),
                        company["linkedin_url"] or None,
                        company["industry"] or None,
                        json.dumps(co_prov),
                        lead["company_id"],
                    )

            # Update pipeline stage. Deterministic lifecycle: a lead whose full
            # enrichment army found NO usable contact is marked 'contact_unavailable'
            # (never a fabricated contact), and is still picked up by the daily
            # re-enrichment sweep. Only leads with a real contact advance to verify.
            has_contact = has_contactable
            await conn.execute(
                "UPDATE leads SET pipeline_stage = $2, updated_at = NOW() WHERE id = $1",
                lead_id,
                "enriched" if has_contact else "contact_unavailable",
            )

            # Persistent job state: DB is source of truth across refresh/restart.
            has_email = bool(person["personal_email"])
            job_status = "completed" if has_email else ("partial" if has_contact else ("failed" if status in ("no_match",) else status))
            await _mark_job(
                conn, job_status, used_provider,
                error=None if has_contact else {"status": status, "provider": used_provider},
                summary={"provider": used_provider, "status": status,
                         "has_email": has_email, "has_contact": has_contact,
                         "credits_used": credits_used,
                         "person_fields": [k for k, v in person.items() if v],
                         "company_fields": [k for k, v in company.items() if v]},
            )
    except Exception as e:  # noqa: BLE001
        async with db_pool.acquire() as conn:
            await _mark_job(conn, "failed", used_provider,
                            error={"error": str(e)[:500], "provider": used_provider})
        raise

    # Recompute lead score
    await recompute_lead_score(db_pool, lead_id)

    # Publish SSE event
    await publish_event(redis_client, requested_by, {
        "type": "enrichment_complete",
        "lead_id": str(lead_id),
        "provider": used_provider,
        "status": status,
        "timestamp": asyncio.get_event_loop().time(),
    })

    logger.info(f"Enrichment complete for lead {lead_id}: provider={used_provider}, status={status}")

    # Chain to verification only when a real contact exists. No-contact leads are
    # parked as 'contact_unavailable' and retried by the sweep — we never fabricate
    # a contact nor spend a verification call on an empty target.
    if enrichment_result and (
        enrichment_result.get("hr_email")
        or enrichment_result.get("hr_mobile")
    ):
        await chain_lead(redis_client, "verification_queue:requests", lead_id,
                         requested_by=requested_by)


async def handle_enrichment_job(payload: dict[str, Any], redis_client: redis.Redis, db_pool: asyncpg.Pool) -> None:
    """Handler wrapper for enrichment_queue consumer."""
    await process_enrichment_job(payload, redis_client, db_pool)


async def consume_enrichment_queue(
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool | None = None,
) -> int:
    """Consume enrichment_queue:requests."""
    if db_pool is None:
        db_pool = await get_db_pool()

    processed = 0
    while True:
        payload: Any = None
        raw_msg: Any = None
        try:
            got = await reliable_brpop(redis_client, "enrichment_queue:requests", timeout=30)
            if got is None:
                await asyncio.sleep(1)
                continue

            raw_msg, payload = got
            await handle_enrichment_job(payload, redis_client, db_pool)
            await ack(redis_client, "enrichment_queue:requests", raw_msg)
            processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in enrichment_queue: {e}")
            if raw_msg is not None:
                await ack(redis_client, "enrichment_queue:requests", raw_msg)
        except Exception as e:
            logger.error(f"Enrichment consumer error: {e}", exc_info=True)
            try:
                if raw_msg is not None:
                    await ack(redis_client, "enrichment_queue:requests", raw_msg)
                await requeue_or_dlq(redis_client, "enrichment_queue:requests", payload)
            except Exception as dlq_err:  # noqa: BLE001
                # The job was already acked out of :processing, so a failed
                # requeue/DLQ write leaves no copy anywhere. Surface it at ERROR
                # with the payload so an operator can recover it instead of the
                # lead silently never being enriched.
                logger.error(
                    f"JOB LOST in enrichment_queue:requests: acked but requeue/DLQ failed ({dlq_err}); "
                    f"payload={str(payload)[:200]}"
                )
            await asyncio.sleep(5)

    return processed
