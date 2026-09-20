"""Reacher result -> SRS §6.1 email status.

The failure this guards against: Reacher reports *sender-side* problems in the
same `smtp.error` field as real bounces. Google answers a datacenter IP with
"5.2.1 ... does not exist", which is reputation throttling, not a dead mailbox.
Treating any smtp.error as invalid marked deliverable leads undeliverable.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from scrapers.verification_worker import classify_reacher_result  # noqa: E402


def _r(reachable="unknown", *, disposable=False, role=False, smtp_error=None):
    out = {"is_reachable": reachable, "misc": {"is_disposable": disposable,
                                               "is_role_account": role}}
    if smtp_error:
        out["smtp"] = {"error": {"type": "SmtpError", "message": smtp_error}}
    return out


@pytest.mark.parametrize("payload,want", [
    (_r("true"), "valid"),
    # Reacher >=0.8 scale (the pinned 0.8.22 image speaks this dialect).
    (_r("safe"), "valid"),
    (_r("risky"), "catch_all"),
    (_r("false"), "invalid"),
    (_r("invalid"), "invalid"),
    (_r("false", disposable=True), "disposable"),
    (_r("unknown", disposable=True), "disposable"),
    (_r("unknown", role=True), "catch_all"),
    (_r("unknown"), "unknown"),
    ("WEIRD", "unknown"),
])
def test_basic_mapping(payload, want):
    assert classify_reacher_result(payload) == want


# --- reputation / transport errors must NOT invalidate -----------------------
@pytest.mark.parametrize("msg", [
    "permanent: 5.2.1 The email account that you tried to reach does not exist",
    "io: could not resolve address `(\".\", 25)`",
    "connection refused",
    "temporary failure, try again later",
    "452 too many recipients",
    "timed out",
])
def test_sender_side_smtp_errors_are_not_bounces(msg):
    assert classify_reacher_result(_r("unknown", smtp_error=msg)) == "unknown"


# --- genuine mailbox-not-found still invalidates -----------------------------
@pytest.mark.parametrize("msg", [
    "550 5.1.1 The email account that you tried to reach does not exist",
    "user unknown",
    "no such user here",
    "550 recipient address rejected",
    "550 mailbox unavailable",
])
def test_hard_bounces_are_invalid(msg):
    assert classify_reacher_result(_r("true", smtp_error=msg)) == "invalid"


def test_google_5_2_1_is_reputation_but_5_1_1_is_dead():
    """Both mention 'does not exist'; only 5.1.1 means the address is gone."""
    assert classify_reacher_result(_r("unknown", smtp_error=(
        "permanent: 5.2.1 The email account that you tried to reach does not exist"))) == "unknown"
    assert classify_reacher_result(_r("unknown", smtp_error=(
        "550 5.1.1 The email account that you tried to reach does not exist"))) == "invalid"


def test_missing_fields_do_not_raise():
    assert classify_reacher_result({}) == "unknown"
    assert classify_reacher_result({"smtp": None}) == "unknown"
    assert classify_reacher_result({"smtp": {"error": "plain string"}}) == "unknown"
