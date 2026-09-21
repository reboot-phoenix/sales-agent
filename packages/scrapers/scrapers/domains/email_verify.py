"""Deliverability verification for an email address we already discovered.

This module answers exactly one question: *is this address deliverable?* It does
**not** invent addresses. There is no permutation engine here and no "the pattern
is first.last@ so let's assume" logic — inventing an address would violate the
platform's zero-fabrication rule, because a plausible-looking wrong email is
worse than a known-missing one.

Two checks are performed, cheapest first:

1. **MX** — does the domain actually accept mail? A domain with no MX record can
   never receive our outreach, so any address on it is downgraded regardless of
   how confidently a page listed it.
2. **SMTP RCPT** — a handshake with the domain's mail exchanger to ask whether the
   specific mailbox exists. Many servers accept every address (catch-all) or
   refuse to answer; both cases are reported as *unknown*, never as verified.

Results are graded so the rest of the system can decide what is sendable:

* ``verified``      — MX answered and the mailbox was explicitly accepted.
* ``catch_all``     — the domain accepts anything, so acceptance proves nothing.
* ``undeliverable`` — the domain or mailbox explicitly rejected (or has no MX).
* ``unknown``       — we could not complete a check (no DNS, blocked, timeout).

Network access is injected (``resolver`` / ``smtp``) so every branch is testable
offline and so callers can supply their own infrastructure.
"""

from __future__ import annotations

import logging
import re
import socket
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")

# Addresses that are structurally fine but never a real inbox for a person.
ROLE_LOCAL_PARTS = frozenset({
    "info", "contact", "admin", "administrator", "webmaster", "postmaster",
    "noreply", "no-reply", "donotreply", "abuse", "support", "helpdesk",
})
# Disposable/typo domains we refuse to treat as deliverable-to-a-person.
DEAD_DOMAINS = frozenset({
    "example.com", "example.org", "test.com", "localhost", "invalid", "email.com",
})

SMTP_PROBE_TIMEOUT = 8
MX_LOOKUP_TIMEOUT = 8
PREFERRED_MX_PREFIXES = ("aspmx.l.google.com", "alt1.aspmx", "alt2.aspmx")


@dataclass
class EmailVerification:
    """The verdict for one address, with the evidence behind it."""

    email: str
    status: str                      # verified | catch_all | undeliverable | unknown
    reason: str
    mx_hosts: list[str] = field(default_factory=list)
    smtp_code: Optional[int] = None
    smtp_message: Optional[str] = None
    grade: Optional[str] = None      # A | B | C | None
    checked_at: str = ""

    @property
    def is_sendable(self) -> bool:
        """Only an explicit acceptance of a non-catch-all mailbox is sendable."""
        return self.status == "verified"

    def to_dict(self) -> dict[str, Any]:
        return {
            "email": self.email,
            "status": self.status,
            "reason": self.reason,
            "mx_hosts": list(self.mx_hosts),
            "smtp_code": self.smtp_code,
            "smtp_message": self.smtp_message,
            "grade": self.grade,
            "checked_at": self.checked_at,
        }


def is_syntactically_valid(email: Optional[str]) -> bool:
    """RFC-ish shape check only — says nothing about whether the mailbox exists."""
    if not email or not isinstance(email, str):
        return False
    candidate = email.strip()
    if len(candidate) > 254 or ".." in candidate or candidate.endswith("."):
        return False
    return bool(EMAIL_RE.match(candidate))


def email_domain(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    domain = email.rsplit("@", 1)[1].strip().lower().rstrip(".")
    if not domain or "." not in domain:
        return None
    return domain


def local_part(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[0].strip().lower()


def is_role_address(email: Optional[str]) -> bool:
    """True for shared/role mailboxes (``placement@``) rather than a person."""
    lp = local_part(email)
    if not lp:
        return False
    base = lp.split("+", 1)[0]
    if base in ROLE_LOCAL_PARTS:
        return True
    # Separator-free role names too: "placementcell@", "tpooffice@".
    return any(base.startswith(prefix) for prefix in
               ("placement", "tpo", "principal", "director", "dean", "hod",
                "admission", "office", "career", "hr", "recruit"))


def grade_for(status: str, *, role_address: bool = False) -> Optional[str]:
    """Map a verdict to the A/B/C grade stored on contacts.

    An explicitly accepted *person* mailbox is A. A shared role mailbox is B: it
    reaches the institution reliably but not a named individual. Everything
    unproven is C — stored and usable, but never presented as verified.
    """
    if status == "verified":
        return "B" if role_address else "A"
    if status in ("catch_all", "unknown"):
        return "C"
    return None  # undeliverable: no grade, the locator is unusable


def mx_hosts(domain: str, *, resolver: Optional[Callable[[str], Any]] = None) -> list[str]:
    """Return MX hostnames for a domain, best first. Never raises."""
    domain = domain.strip().lower().rstrip(".")
    if not domain:
        return []
    if resolver is not None:
        try:
            records = resolver(domain) or []
        except Exception as e:  # noqa: BLE001 - DNS trouble is reported, not raised
            logger.debug("MX lookup failed for %s: %s", domain, e)
            return []
        return _normalize_mx_records(records)
    try:  # pragma: no cover - exercised only when dnspython is installed
        import dns.resolver  # type: ignore

        answers = dns.resolver.resolve(domain, "MX", lifetime=MX_LOOKUP_TIMEOUT)
        return _normalize_mx_records([
            (getattr(r, "preference", 0), str(getattr(r, "exchange", "")).rstrip("."))
            for r in answers
        ])
    except Exception as e:  # noqa: BLE001
        logger.debug("MX lookup error for %s: %s", domain, e)
        return []


def _normalize_mx_records(records: Iterable[Any]) -> list[str]:
    """Accept tuples, dicts, strings, or dnspython answers; return hostnames."""
    parsed: list[tuple[int, str]] = []
    for record in records:
        pref, host = 0, None
        if isinstance(record, (tuple, list)) and len(record) >= 2:
            pref, host = record[0], record[1]
        elif isinstance(record, dict):
            pref = record.get("preference", record.get("priority", 0)) or 0
            host = record.get("exchange") or record.get("host")
        elif isinstance(record, str):
            host = record
        if not host:
            continue
        host = str(host).strip().rstrip(".").lower()
        if not host or host in (".", "null"):
            continue
        try:
            pref = int(pref)
        except (TypeError, ValueError):
            pref = 0
        parsed.append((pref, host))
    # Stable ordering: preference first, then a nudge toward hosts that are known
    # to answer probes reliably, then name for determinism.
    def sort_key(item: tuple[int, str]) -> tuple[int, int, str]:
        _, host = item
        preferred = 0 if any(host.startswith(p) for p in PREFERRED_MX_PREFIXES) else 1
        return (item[0], preferred, host)

    seen: list[str] = []
    for _, host in sorted(parsed, key=sort_key):
        if host not in seen:
            seen.append(host)
    return seen


def _default_smtp_probe(host: str, email: str, timeout: int) -> tuple[int, str]:
    """SMTP RCPT handshake. Returns (code, message). Raises on transport errors."""
    import smtplib

    server = smtplib.SMTP(timeout=timeout)
    try:
        server.connect(host, 25)
        server.helo(socket.gethostname() or "localhost")
        server.mail("verify@invalid")  # a non-routable sender keeps this a lookup, not a send
        code, message = server.rcpt(email)
        return int(code), message.decode(errors="ignore") if isinstance(message, bytes) else str(message)
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001 - quit() failing after a probe is irrelevant
            pass


# 5xx codes are permanent rejections. 4xx/2xx on RCPT never prove a real mailbox.
_REJECT_CODES = frozenset({550, 551, 552, 553, 554, 555, 556, 557})


def verify_email(
    email: Optional[str],
    *,
    resolver: Optional[Callable[[str], Any]] = None,
    smtp: Optional[Callable[[str, str, int], tuple[int, str]]] = None,
    timeout: int = SMTP_PROBE_TIMEOUT,
    check_smtp: bool = True,
    now: Optional[str] = None,
) -> EmailVerification:
    """Verify one address. Never raises, never invents a verdict.

    ``resolver``/``smtp`` are injected for tests; production falls back to
    dnspython (MX) and an SMTP RCPT handshake.
    """
    from .normalize import now_iso  # local import keeps this module dependency-free

    checked_at = now or now_iso()
    if not is_syntactically_valid(email):
        return EmailVerification(
            email=(email or "").strip(), status="undeliverable",
            reason="not a valid email address", checked_at=checked_at,
        )
    addr = (email or "").strip()
    domain = email_domain(addr) or ""
    if domain in DEAD_DOMAINS:
        return EmailVerification(
            email=addr, status="undeliverable",
            reason=f"{domain} cannot receive mail", checked_at=checked_at,
        )

    hosts = mx_hosts(domain, resolver=resolver)
    if not hosts:
        return EmailVerification(
            email=addr, status="undeliverable",
            reason="domain publishes no MX record", checked_at=checked_at,
        )

    role = is_role_address(addr)
    base = EmailVerification(email=addr, status="unknown", mx_hosts=hosts,
                             reason="mail server did not answer the check",
                             checked_at=checked_at)
    if not check_smtp:
        base.reason = "MX present; SMTP check skipped"
        base.grade = grade_for(base.status, role_address=role)
        return base

    probe = smtp or _default_smtp_probe
    # A catch-all server accepts every address, including one that cannot exist,
    # which makes an acceptance meaningless. The canary is probed *first* so a
    # 250 on the real address is only read as verified on a non-catch-all server.
    catch_all = _catch_all_state(addr, probe, hosts, timeout)

    codes: list[int] = []
    for host in hosts:
        try:
            code, message = probe(host, addr, timeout)
        except Exception as e:  # noqa: BLE001 - a refusing server must not raise
            base.smtp_message = str(e)[:200]
            continue
        codes.append(code)
        base.smtp_code = code
        base.smtp_message = (message or "")[:200]
        if code in _REJECT_CODES:
            base.status = "undeliverable"
            base.reason = f"mailbox rejected by {host} ({code})"
            base.grade = None
            return base
        if 200 <= code < 300:
            if catch_all:
                base.status = "catch_all"
                base.reason = "server accepts any address - cannot confirm the mailbox"
            else:
                base.status = "verified"
                base.reason = f"mailbox accepted by {host}"
            base.grade = grade_for(base.status, role_address=role)
            return base
        # 4xx / unexpected: try the next exchanger, then report unknown.
    if not codes:
        base.status = "unknown"
        base.reason = "no mail server answered (timeout or blocked)"
    else:
        base.status = "unknown"
        base.reason = "mailbox state inconclusive"
    base.grade = grade_for(base.status, role_address=role)
    return base


def _catch_all_state(
    email: str,
    probe: Callable[[str, str, int], tuple[int, str]],
    hosts: list[str],
    timeout: int,
) -> bool:
    """True when a cannot-exist address is accepted — the domain is a catch-all.

    False means the server distinguished (or refused) the canary, so acceptance of
    a real address carries information. Errors are swallowed: a canary that cannot
    run simply leaves us conservative, and we never raise out of verification.
    """
    domain = email_domain(email)
    if not domain:
        return False
    canary = f"no-such-mailbox-{abs(hash(email)) % 10**8}@{domain}"
    for host in hosts[:2]:
        try:
            code, _ = probe(host, canary, timeout)
        except Exception:  # noqa: BLE001
            continue
        if 200 <= code < 300:
            return True
    return False


def verify_many(
    emails: Iterable[Optional[str]],
    *,
    resolver: Optional[Callable[[str], Any]] = None,
    smtp: Optional[Callable[[str, str, int], tuple[int, str]]] = None,
    timeout: int = SMTP_PROBE_TIMEOUT,
    check_smtp: bool = True,
) -> list[EmailVerification]:
    """Verify a batch, de-duplicating addresses case-insensitively.

    MX results are cached per domain for the batch so a 200-college sweep does not
    re-ask DNS for the same institution repeatedly.
    """
    seen: dict[str, EmailVerification] = {}
    mx_cache: dict[str, list[str]] = {}

    def cached_resolver(domain: str) -> list[str]:
        key = domain.lower()
        if key not in mx_cache:
            mx_cache[key] = mx_hosts(domain, resolver=resolver)
        return mx_cache[key]

    for email in emails:
        addr = (email or "").strip()
        if not addr:
            continue
        key = addr.lower()
        if key in seen:
            continue
        seen[key] = verify_email(
            addr, resolver=cached_resolver, smtp=smtp, timeout=timeout,
            check_smtp=check_smtp,
        )
    return list(seen.values())


def verification_sql_status(status: str) -> str:
    """Map a verdict onto the ``verification_status`` vocabulary of the tables."""
    return {
        "verified": "verified",
        "catch_all": "partially_verified",
        "unknown": "unverified",
        "undeliverable": "failed",
    }.get(status, "unverified")
