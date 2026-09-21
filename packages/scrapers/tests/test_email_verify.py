"""Deliverability verification: what we prove, and what we refuse to claim.

Every case here is offline — the DNS resolver and the SMTP prober are injected.
The rule the tests enforce hardest: an address is only ever reported as verified
when a mail server explicitly accepted a non-catch-all mailbox, and nothing in
this module ever invents an address.
"""
import pytest

from scrapers.domains import email_verify as ev


def _mx_resolver(hosts_by_domain):
    def resolve(domain):
        return hosts_by_domain.get(domain, [])
    return resolve


def _smtp(codes_by_email):
    """A well-behaved server: it only accepts the addresses it knows.

    Defaulting unknown addresses to 550 (rather than accepting them) keeps the
    fake honest — a server that accepted everything is a catch-all, which is
    tested explicitly elsewhere.
    """

    def probe(host, email, timeout):
        code = codes_by_email.get(email.lower(), 550)
        return code, f"rcpt {code}"

    return probe


def test_shape_check_rejects_junk_but_never_guesses():
    assert ev.is_syntactically_valid("tpo@college.edu")
    assert not ev.is_syntactically_valid("tpo@college")
    assert not ev.is_syntactically_valid("not-an-email")
    assert not ev.is_syntactically_valid(None)
    assert not ev.is_syntactically_valid("a..b@college.edu")


def test_domain_and_local_part_extraction():
    assert ev.email_domain("Tpo@College.EDU.") == "college.edu"
    assert ev.email_domain("broken") is None
    assert ev.local_part("Tpo.Office@college.edu") == "tpo.office"


def test_role_addresses_are_recognised():
    assert ev.is_role_address("placement@college.edu")
    assert ev.is_role_address("tpo@college.edu")
    assert ev.is_role_address("placementcell@college.edu")
    assert ev.is_role_address("info@college.edu")
    assert not ev.is_role_address("asha.rao@college.edu")


def test_mx_normalisation_is_deterministic_and_prefers_reliable_exchangers():
    hosts = ev.mx_hosts("college.edu", resolver=_mx_resolver({
        # Lower preference number wins; the alternates must not be dropped.
        "college.edu": [(20, "alt2.aspmx.l.google.com."), (10, "mail.college.edu"),
                        (5, "aspmx.l.google.com."), (10, "mail.college.edu")],
    }))
    assert hosts == ["aspmx.l.google.com", "mail.college.edu", "alt2.aspmx.l.google.com"]


def test_mx_failure_is_unknown_not_verified():
    assert ev.mx_hosts("college.edu", resolver=_mx_resolver({})) == []

    def boom(domain):
        raise RuntimeError("dns down")

    assert ev.mx_hosts("college.edu", resolver=boom) == []


def test_no_mx_means_undeliverable():
    result = ev.verify_email("tpo@nomail.edu", resolver=_mx_resolver({}))
    assert result.status == "undeliverable"
    assert result.grade is None
    assert not result.is_sendable


def test_accepted_person_mailbox_is_verified_and_grade_a():
    result = ev.verify_email(
        "asha.rao@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=_smtp({"asha.rao@college.edu": 250}),
    )
    assert result.status == "verified"
    assert result.grade == "A"
    assert result.is_sendable
    assert result.mx_hosts == ["mail.college.edu"]


def test_accepted_role_mailbox_is_verified_but_only_grade_b():
    result = ev.verify_email(
        "placement@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=_smtp({"placement@college.edu": 250}),
    )
    assert result.status == "verified"
    assert result.grade == "B"          # reaches the desk, not a named person


def test_permanent_rejection_is_undeliverable_and_ungraded():
    result = ev.verify_email(
        "gone@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=_smtp({"gone@college.edu": 550}),
    )
    assert result.status == "undeliverable"
    assert result.grade is None
    assert result.smtp_code == 550


def test_catch_all_domain_is_never_verified():
    # The domain accepts literally anything, including our canary address.
    result = ev.verify_email(
        "placement@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=lambda host, email, timeout: (250, "ok"),
    )
    assert result.status == "catch_all"
    assert result.grade == "C"
    assert not result.is_sendable


def test_greylisting_timeout_is_unknown_not_undeliverable():
    def probe(host, email, timeout):
        if "no-such-mailbox" in email:
            return 550, "no such user"
        return 451, "try again later"

    result = ev.verify_email(
        "asha@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=probe,
    )
    assert result.status == "unknown"
    assert result.grade == "C"
    assert "inconclusive" in result.reason


def test_transport_errors_are_reported_never_raised():
    def probe(host, email, timeout):
        raise OSError("connection refused")

    result = ev.verify_email(
        "asha@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=probe,
    )
    assert result.status == "unknown"
    assert "no mail server answered" in result.reason


def test_failed_first_exchanger_falls_through_to_the_next():
    def probe(host, email, timeout):
        if host == "mail1.college.edu":
            raise OSError("unreachable")
        # The surviving exchanger still distinguishes real mailboxes from the
        # canary, so its acceptance is meaningful.
        return (250, "ok") if email == "asha@college.edu" else (550, "no such user")

    result = ev.verify_email(
        "asha@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail1.college.edu", "mail2.college.edu"]}),
        smtp=probe,
    )
    assert result.status == "verified"


def test_smtp_can_be_skipped_and_is_then_honestly_unknown():
    result = ev.verify_email(
        "asha@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        check_smtp=False,
    )
    assert result.status == "unknown"
    assert "skipped" in result.reason


def test_disposable_and_test_domains_are_undeliverable():
    for email in ("a@example.com", "a@test.com", "a@localhost"):
        result = ev.verify_email(email, resolver=_mx_resolver({"example.com": ["x"]}))
        assert result.status == "undeliverable"


def test_verify_many_dedupes_and_caches_mx_per_domain():
    calls = []

    def resolver(domain):
        calls.append(domain)
        return ["mail.college.edu"]

    results = ev.verify_many(
        ["asha@college.edu", "ASHA@college.edu", "", None, "ravi@college.edu"],
        resolver=resolver,
        smtp=_smtp({}),
    )
    assert len(results) == 2
    assert calls == ["college.edu"]          # one lookup, not one per address


def test_status_vocabulary_maps_onto_the_contact_tables():
    assert ev.verification_sql_status("verified") == "verified"
    assert ev.verification_sql_status("catch_all") == "partially_verified"
    assert ev.verification_sql_status("unknown") == "unverified"
    assert ev.verification_sql_status("undeliverable") == "failed"


def test_result_serialises_for_storage():
    result = ev.verify_email(
        "placement@college.edu",
        resolver=_mx_resolver({"college.edu": ["mail.college.edu"]}),
        smtp=_smtp({"placement@college.edu": 250}),
    )
    payload = result.to_dict()
    assert payload["email"] == "placement@college.edu"
    assert payload["status"] == "verified"
    assert set(payload) == {
        "email", "status", "reason", "mx_hosts", "smtp_code", "smtp_message",
        "grade", "checked_at",
    }


def test_module_has_no_address_generation_helper():
    """Guardrail: fabricated addresses must never become a feature by accident."""
    public = {name for name in dir(ev) if not name.startswith("_")}
    forbidden = {"permutate", "guess_email", "generate_email", "infer_email",
                 "pattern_email", "predict_email"}
    assert not (public & forbidden)


@pytest.mark.parametrize("phone,expected", [
    ("+91 98765 43210", True),
    ("080-2345-6789", True),
    ("12345", False),
    (None, False),
    ("1111111111", False),
    ("", False),
])
def test_phone_usability_is_shared_with_outreach(phone, expected):
    from scrapers.domains.outreach import phone_worth_sending

    assert phone_worth_sending(phone) is expected
