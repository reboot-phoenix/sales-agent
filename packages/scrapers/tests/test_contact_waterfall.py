"""The free OSINT contact waterfall: layer ordering, verification gates, and the
strict rules that separate a live mailbox from a plausible-looking guess.

Pins (master spec §2, §6):
  * role inboxes are probed on the entity's own domain and SMTP-verified —
    a hard rejection is dropped, never stored;
  * personal inference ONLY runs from a real sample address (learned format),
    never blind permutation;
  * SERP-published addresses are verified before being offered, and dropped
    when the mail server rejects them;
  * the waterfall NEVER raises — a broken layer degrades to an empty result
    with the error in the report, so one bad domain cannot sink a sweep.

Every network-ish call is injected/faked; nothing here touches the internet.
"""
import pytest

from scrapers.domains import contact_waterfall as cw
from scrapers.domains.email_verify import EmailVerification


def _verdict(email: str, status: str, smtp_code=None) -> EmailVerification:
    return EmailVerification(
        email=email, status=status,
        reason={"verified": "accepted", "catch_all": "catch-all server",
                "undeliverable": "rejected", "unknown": "no answer"}[status],
        smtp_code=smtp_code, checked_at="2026-09-22T00:00:00Z",
    )


# ---------------------------------------------------------------------------
# Layer R: role inboxes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_role_inbox_accepted_and_verified(monkeypatch):
    """An inbox the mail server accepts comes back verified at role confidence."""
    seen: list[str] = []

    def fake_verify(email, *, check_smtp=True, **kw):
        seen.append(email)
        # tpo@ and placements@ exist on the domain; everything else rejects.
        if email.split("@")[0] in ("tpo", "placements"):
            return _verdict(email, "verified", 250)
        return _verdict(email, "undeliverable", 550)

    monkeypatch.setattr(cw, "_verify", fake_verify)
    hits = await cw.discover_role_inboxes("https://www.example.ac.in", check_smtp=True)

    emails = [h.email for h in hits]
    assert "tpo@example.ac.in" in emails and "placements@example.ac.in" in emails
    # Hard-rejected candidates are dropped entirely, never returned as data.
    assert all(not h.email.startswith(("info@", "contact@")) for h in hits)
    assert all(h.verified and h.confidence == cw.CONF_ROLE_SMTP_VERIFIED for h in hits)
    # Candidates were tried on the apex host (www stripped).
    assert all(h.email.endswith("@example.ac.in") for h in hits)


@pytest.mark.asyncio
async def test_role_inbox_unknown_server_never_marked_verified(monkeypatch):
    """MX fine but SMTP inconclusive → stored candidate, low confidence, unverified."""
    def fake_verify(email, *, check_smtp=True, **kw):
        return _verdict(email, "unknown")

    monkeypatch.setattr(cw, "_verify", fake_verify)
    hits = await cw.discover_role_inboxes("https://example.ac.in", check_smtp=True)

    assert hits, "MX-valid role candidates are still reported"
    assert all(not h.verified for h in hits)
    assert all(h.confidence == cw.CONF_ROLE_MX_ONLY for h in hits)


@pytest.mark.asyncio
async def test_role_inbox_no_domain_yields_nothing():
    assert await cw.discover_role_inboxes(None) == []
    assert await cw.discover_role_inboxes("not a url") == []


# ---------------------------------------------------------------------------
# Layer P: pattern inference
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_personal_inference_requires_a_real_sample(monkeypatch):
    """No sample → no inference. Blind permutation is fabrication and is banned."""
    called = {"n": 0}

    def fake_verify(email, *, check_smtp=True, **kw):
        called["n"] += 1
        return _verdict(email, "verified", 250)

    monkeypatch.setattr(cw, "_verify", fake_verify)
    got = await cw.infer_personal_email(
        "Anita Deshmukh", "example.ac.in", known_emails=[],
    )
    assert got is None
    assert called["n"] == 0, "no SMTP traffic may happen without a learned pattern"


@pytest.mark.asyncio
async def test_personal_inference_learns_format_and_verifies(monkeypatch):
    """Sample placements@cell@... teaches nothing, but a person-format sample does."""
    def fake_verify(email, *, check_smtp=True, **kw):
        # Only the correctly inferred address is accepted by the mail server.
        if email == "a.deshmukh@example.ac.in":
            return _verdict(email, "verified", 250)
        return _verdict(email, "undeliverable", 550)

    monkeypatch.setattr(cw, "_verify", fake_verify)
    got = await cw.infer_personal_email(
        "Anita Deshmukh", "example.ac.in",
        known_emails=["r.sharma@example.ac.in"],  # real sample: f.last format
    )
    assert got is not None
    assert got.email == "a.deshmukh@example.ac.in"
    assert got.verified and got.layer == "pattern_inferred"


@pytest.mark.asyncio
async def test_personal_inference_rejected_mailbox_is_dropped(monkeypatch):
    """The mail server says the inferred mailbox does not exist → nothing stored."""

    def fake_verify(email, *, check_smtp=True, **kw):
        return _verdict(email, "undeliverable", 550)

    monkeypatch.setattr(cw, "_verify", fake_verify)
    got = await cw.infer_personal_email(
        "Anita Deshmukh", "example.ac.in",
        known_emails=["r.sharma@example.ac.in"],
    )
    assert got is None


# ---------------------------------------------------------------------------
# Layer D: SERP-published addresses
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_published_addresses_filtered_to_domain_and_dropped_junk(monkeypatch):
    async def fake_snippets(query):
        if "tpo" in query:
            return [
                'Contact: tpo@example.ac.in, placements@example.ac.in — Placement Cell',
                'unrelated@other.org should not leak in',
                'noreply@example.ac.in must be dropped',
            ]
        return []

    monkeypatch.setattr("scrapers.utils.serp_dork._fetch_snippets", fake_snippets)
    hits = await cw.discover_published_addresses("example.ac.in")

    emails = [h.email for h in hits]
    assert "tpo@example.ac.in" in emails and "placements@example.ac.in" in emails
    assert all(not e.endswith("@other.org") for e in emails)
    assert all(not e.startswith("noreply@") for e in hits and emails)
    assert all(h.layer == "serp_published" for h in hits)


# ---------------------------------------------------------------------------
# Full waterfall ordering + failure isolation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_waterfall_orders_verified_first_and_dedupes(monkeypatch):
    def fake_verify(email, *, check_smtp=True, **kw):
        if email.startswith("tpo@"):
            return _verdict(email, "verified", 250)
        return _verdict(email, "unknown")

    monkeypatch.setattr(cw, "_verify", fake_verify)
    async def fake_published(domain, *, max_results=5):
        return [cw.WaterfallContact(
            email="tpo@example.ac.in", layer="serp_published", confidence=55,
            verified=False, status="unknown", role_address=True,
        )]

    monkeypatch.setattr(cw, "discover_published_addresses", fake_published)
    out = await cw.run_contact_waterfall("https://example.ac.in", check_smtp=True)

    emails = [c["email"] for c in out["candidates"]]
    assert emails.count("tpo@example.ac.in") == 1, "deduped across layers"
    top = out["candidates"][0]
    assert top["verified"] and top["confidence"] >= top["confidence"]  # sanity
    assert out["report"]["verified"] >= 1


@pytest.mark.asyncio
async def test_waterfall_never_raises_and_reports_errors(monkeypatch):
    async def boom(*a, **kw):
        raise RuntimeError("dns exploded")

    monkeypatch.setattr(cw, "discover_role_inboxes", boom)
    monkeypatch.setattr(cw, "discover_published_addresses", boom)
    out = await cw.run_contact_waterfall("https://example.ac.in", check_smtp=False)

    assert out["candidates"] == []
    assert any("dns exploded" in e for e in out["report"]["errors"])


@pytest.mark.asyncio
async def test_waterfall_no_domain_short_circuits():
    out = await cw.run_contact_waterfall("   ", check_smtp=False)
    assert out["candidates"] == []
    assert out["report"]["errors"] == ["no domain"]
