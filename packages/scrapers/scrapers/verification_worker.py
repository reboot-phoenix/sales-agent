"""
Verification worker: consumes verification_queue:requests.

Per SRS §6:
- Email: calls self-hosted Reacher API (http://reacher:5050)
- WhatsApp: calls self-hosted whatsapp-web.js microservice (http://whatsapp-service:3050)

If services are unavailable, marks status as 'unknown' (graceful degradation per §6.3).

Updates:
- verification_log table (channel, result, raw_response)
- leads table (email_status / whatsapp_status, pipeline_stage -> 'verified')
- Pushes SSE event to user channel
- Recomputes lead score
"""

import json
import re
import asyncio
import logging
import os
from typing import Any
from scrapers.utils.mx_verifier import check_email_deliverability

import redis.asyncio as redis
import asyncpg

from .utils.db import get_db_pool
from .api_utils.scoring_client import recompute_lead_score
from .queue import chain_lead, requeue_or_dlq, reliable_brpop, ack, publish_event

from .utils.redact import redact_email, redact_phone

logger = logging.getLogger(__name__)


TRANSIENT_SMTP = re.compile(
    # Sender-side / temporary failures. Google answers a datacenter IP with
    # "5.2.1 ... does not exist", which is reputation throttling and uses the
    # same wording as a real recipient bounce; 5.7.x is policy rejection.
    r"\b(4\d\d|5\.2\.\d|5\.7\.\d)\b|try again|temporar|rate.?limit|"
    r"reputation|could not resolve|connection refused|timed out|"
    r"unavailable for strategic",
    re.I,
)
HARD_BOUNCE = re.compile(
    # Only an explicit *recipient* rejection proves the mailbox is gone.
    r"user unknown|no such user|not deliverable|mailbox unavailable|"
    r"recipient address rejected|address (rejected|invalid)|"
    r"\b5\.1\.1\b|\b5\.0\.0\b|\b550 5\.1\b",
    re.I,
)


def classify_reacher_result(result: dict[str, Any]) -> str:
    """Map one Reacher result object onto the SRS §6.1 email-status enum.

    Pure and separated from the HTTP call so the reputation-vs-bounce rule below
    is testable without a running Reacher or outbound SMTP. Treating any
    smtp.error as invalid silently destroyed deliverable leads, because Reacher
    reports our own egress problems in that same field.
    """
    if not isinstance(result, dict):
        # Reacher can hand back a list, a string or an error body; never crash on
        # shape, because an exception here aborts verification for the whole job.
        return "unknown"
    misc = result.get("misc") or {}
    is_reachable = str(result.get("is_reachable", "unknown")).lower()
    is_disposable = bool(misc.get("is_disposable", False))
    is_role = bool(misc.get("is_role_account", False))

    smtp = result.get("smtp")
    smtp_raw = smtp.get("error") if isinstance(smtp, dict) else None
    if isinstance(smtp_raw, dict):
        smtp_msg = str(smtp_raw.get("message", ""))
    elif smtp_raw is None:
        smtp_msg = ""
    else:
        smtp_msg = str(smtp_raw)
    has_smtp_error = bool(smtp_raw)

    hard_bounce = has_smtp_error and not TRANSIENT_SMTP.search(smtp_msg) \
        and bool(HARD_BOUNCE.search(smtp_msg))

    if hard_bounce:
        return "invalid"
    # Reacher >=0.8 serializes Reachable as safe|risky|invalid|unknown (the
    # legacy true/false booleans still appear from older pinned builds), so
    # both scales must map or every fresh verdict degrades to unknown.
    if is_reachable in ("true", "safe"):
        return "valid"
    if is_reachable == "risky":
        # accept-all / gray area: SRS maps these to catch_all (deliverable,
        # not individually confirmed).
        return "catch_all"
    if is_reachable in ("false", "invalid"):
        return "disposable" if is_disposable else "invalid"
    if is_reachable == "unknown":
        if is_disposable:
            return "disposable"
        if is_role:
            return "catch_all"
    return "unknown"


async def verify_email_inhouse(email: str) -> dict[str, Any]:
    """Fallback verifier: MX + SMTP RCPT, run in-process.

    Maps the domains.email_verify verdict onto the job pipeline's vocabulary
    (valid | invalid | catch_all | unknown). The SMTP handshake is blocking, so it
    runs in a worker thread to keep the event loop free.
    """
    from .domains.email_verify import is_role_address, verify_email

    try:
        verdict = await asyncio.to_thread(verify_email, email)
    except Exception as e:  # noqa: BLE001 - verification must never break the job
        logger.warning("In-house verification failed for %s: %s", redact_email(email), e)
        return {"status": "unknown", "raw": {"error": str(e)}}
    if verdict.status == "verified":
        # A shared role mailbox is not proof that a person can be reached, so it
        # keeps the weaker 'catch_all' bucket the pipeline already understands.
        status = "catch_all" if is_role_address(email) else "valid"
    elif verdict.status == "catch_all":
        status = "catch_all"
    elif verdict.status == "undeliverable":
        status = "invalid"
    else:
        status = "unknown"
    return {"status": status, "raw": {"verifier": "inhouse_smtp", **verdict.to_dict()}}


async def verify_email_reacher(email: str, reacher_url: str | None = None) -> dict[str, Any]:
    """Verify an email using the Reacher API.

    Returns {status, deliverable, ...} mapped to SRS §6.1 enum values:
    valid | invalid | catch_all | disposable | unknown
    """
    import httpx

    url = (reacher_url or os.environ.get("REACHER_URL", "http://reacher:5050")) + "/"
    payload = {"to_emails": [email]}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                logger.warning(f"Reacher returned {resp.status_code}")
                return {"status": "unknown", "raw": {"error": f"HTTP {resp.status_code}"}}

            data = resp.json()
            # Reacher returns a list of results: [{ is_reachable, misc, mx, smtp, syntax }]
            result = data[0] if isinstance(data, list) and len(data) > 0 else data
            status = classify_reacher_result(result)

            return {"status": status, "raw": result}
    except httpx.ConnectError:
        logger.warning(f"Reacher not reachable at {url}")
        return {"status": "unknown", "raw": {"error": "connection_failed"}}
    except Exception as e:
        logger.warning(f"Reacher verification failed for {redact_email(email)}: {e}")
        return {"status": "unknown", "raw": {"error": str(e)}}


def _wa_configured(base: str | None) -> bool:
    """Is a WhatsApp endpoint actually configured for this deployment?

    WHATSAPP_WEB_URL defaults to localhost:3050 in .env.example, which is wrong
    from inside a container and points at nothing until the service exists. Treat
    an unset value as unconfigured so callers can say so explicitly rather than
    attempting a doomed connection.
    """
    if not base or not base.strip():
        return False
    b = base.strip().lower()
    return "localhost" not in b and "127.0.0.1" not in b


async def verify_whatsapp(
    phone: str, whatsapp_url: str | None = None
) -> dict[str, Any]:
    """Verify a WhatsApp number via whatsapp-web.js microservice.

    Returns {status, ...} mapped to SRS §6.2 enum values:
    registered | not_registered | unknown
    """
    import httpx

    base = whatsapp_url or os.environ.get("WHATSAPP_WEB_URL", "")
    if not _wa_configured(base):
        # Fail fast and honestly instead of spending a 30s timeout on a service
        # that is not deployed: the previous behaviour logged an opaque
        # "All connection attempts failed" that read like a WhatsApp rejection.
        return {"status": "unknown", "raw": {"error": "whatsapp_not_configured"}}

    url = base.rstrip("/") + "/check"
    params = {"phone": phone}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            if resp.status_code != 200:
                return {"status": "unknown", "raw": {"error": f"HTTP {resp.status_code}"}}

            data = resp.json()
            exists = data.get("exists", False)
            status = "registered" if exists else "not_registered"
            return {"status": status, "raw": data}
    except Exception as e:
        logger.error(f"WhatsApp verification failed for {redact_phone(phone)}: {e}")
        return {"status": "unknown", "raw": {"error": str(e)}}


async def process_verification_job(
    payload: dict[str, Any],
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool,
) -> None:
    """Process a single verification job from the queue."""
    lead_id = payload.get("lead_id")
    requested_by = payload.get("requested_by", "system")

    if not lead_id:
        logger.error("Verification job missing lead_id")
        return

    logger.info(f"Processing verification for lead {lead_id}")

    async with db_pool.acquire() as conn:
        lead = await conn.fetchrow(
            """
            SELECT l.id, l.email_status, l.whatsapp_status,
                   hc.personal_email, hc.personal_mobile
            FROM leads l
            LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
            WHERE l.id = $1
            FOR UPDATE OF l
            """,
            lead_id,
        )

        if not lead:
            logger.warning(f"Lead not found: {lead_id}")
            return

        # Contactable values live on the joined hr_contacts row — leads has no
        # hr_email/hr_mobile columns (verified against the authoritative schema).
        email_to_verify = lead["personal_email"] or ""
        phone_to_verify = lead["personal_mobile"] or ""

        email_status = "unknown"
        whatsapp_status = "unknown"

        # Email verification via Reacher
        if email_to_verify:
            # Free DNS pre-flight first: a domain with no MX (or an NXDOMAIN typo)
            # can never receive mail, so there is no reason to spend an SMTP
            # round trip on it. Unknown stays silent -- only a definite False skips.
            mx = await check_email_deliverability(email_to_verify)
            if mx["mx"] is False:
                email_status = "invalid"
                result = {"status": "invalid", "raw": {"mx_check": mx["reason"]}}
            else:
                result = await verify_email_reacher(email_to_verify)
                email_status = result["status"]
                if email_status == "unknown":
                    # Reacher is optional infrastructure. When it is absent or
                    # unwell, fall back to our own MX + SMTP probe rather than
                    # reporting "unknown" for an address we can actually check.
                    fallback = await verify_email_inhouse(email_to_verify)
                    if fallback["status"] != "unknown":
                        result = fallback
                        email_status = fallback["status"]

            await conn.execute(
                """
                INSERT INTO verification_log (lead_id, channel, result, raw_response)
                VALUES ($1, 'email', $2, $3)
                """,
                lead_id,
                email_status,
                json.dumps(result["raw"]),
            )

        # WhatsApp verification
        if phone_to_verify:
            result = await verify_whatsapp(phone_to_verify)
            whatsapp_status = result["status"]

            await conn.execute(
                """
                INSERT INTO verification_log (lead_id, channel, result, raw_response)
                VALUES ($1, 'whatsapp', $2, $3)
                """,
                lead_id,
                whatsapp_status,
                json.dumps(result["raw"]),
            )

        # Lifecycle correctness: 'verified' is only set when a channel genuinely
        # verified as reachable. A lead whose only contact verified as bad (invalid
        # email / not-registered / no contact) is 'verification_failed' — it must
        # NEVER silently read as 'verified'. Discovery and verification stay
        # distinct states per spec.
        email_ok = email_status in ("valid", "catch_all")
        wa_ok = whatsapp_status == "registered"
        new_stage = "verified" if (email_ok or wa_ok) else "verification_failed"

        # Update lead
        await conn.execute(
            """
            UPDATE leads
            SET email_status = $1, whatsapp_status = $2,
                pipeline_stage = $3, updated_at = NOW()
            WHERE id = $4
            """,
            email_status,
            whatsapp_status,
            new_stage,
            lead_id,
        )

    await recompute_lead_score(db_pool, lead_id)

    await publish_event(redis_client, requested_by, {
        "type": "verification_complete",
        "lead_id": str(lead_id),
        "email_status": email_status,
        "whatsapp_status": whatsapp_status,
        "timestamp": asyncio.get_event_loop().time(),
    })

    logger.info(f"Verification complete for lead {lead_id}: email={email_status}, whatsapp={whatsapp_status}")

    # Chain to drafting only for deliverable contacts. DRAFT-ONLY mode: nothing
    # here ever pushes to send_queue — sending to a real HR is always a manual
    # human action via the API.
    if email_status in ("valid", "catch_all"):
        await chain_lead(redis_client, "draft_queue:requests", lead_id,
                         requested_by=requested_by)


async def consume_verification_queue(
    redis_client: redis.Redis,
    db_pool: asyncpg.Pool | None = None,
) -> int:
    """Consume verification_queue:requests."""
    if db_pool is None:
        db_pool = await get_db_pool()

    processed = 0
    while True:
        payload: Any = None
        raw_msg: Any = None
        try:
            got = await reliable_brpop(redis_client, "verification_queue:requests", timeout=30)
            if got is None:
                await asyncio.sleep(1)
                continue

            raw_msg, payload = got
            await process_verification_job(payload, redis_client, db_pool)
            await ack(redis_client, "verification_queue:requests", raw_msg)
            processed += 1
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in verification_queue: {e}")
            if raw_msg is not None:
                await ack(redis_client, "verification_queue:requests", raw_msg)
        except Exception as e:
            logger.error(f"Verification consumer error: {e}", exc_info=True)
            try:
                if raw_msg is not None:
                    await ack(redis_client, "verification_queue:requests", raw_msg)
                await requeue_or_dlq(redis_client, "verification_queue:requests", payload)
            except Exception as dlq_err:  # noqa: BLE001
                # The job was already acked out of :processing, so a failed
                # requeue/DLQ write leaves no copy anywhere. Surface it at ERROR
                # with the payload so an operator can recover it instead of the
                # lead silently never being enriched.
                logger.error(
                    f"JOB LOST in verification_queue:requests: acked but requeue/DLQ failed ({dlq_err}); "
                    f"payload={str(payload)[:200]}"
                )
            await asyncio.sleep(5)

    return processed
