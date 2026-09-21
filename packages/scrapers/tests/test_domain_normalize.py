"""Shared normalization: money, dates, booleans, slugs. No I/O, no network."""
from datetime import datetime, timezone

from scrapers.domains.normalize import (
    as_list,
    clean_text,
    extract_domain,
    normalize_name_key,
    parse_bool,
    parse_date,
    parse_date_range,
    parse_datetime,
    parse_money,
    slugify,
    strip_html,
)


def test_clean_text_and_strip_html():
    assert clean_text("  a   b  ") == "a b"
    assert strip_html("<p>Hello <b>world</b></p>") == "Hello world"
    assert strip_html("<script>x=1</script>Real") == "Real"


def test_slugify_and_name_key():
    assert slugify("Smart India Hackathon (2026)") == "smart-india-hackathon-2026"
    assert normalize_name_key("IIT (BHU) Varanasi") == "iitbhuvaranasi"
    # Same entity, different punctuation/casing -> identical key.
    assert normalize_name_key("IIT-BHU, Varanasi") == normalize_name_key("iit bhu varanasi")


def test_parse_bool_tristate_never_guesses():
    assert parse_bool("yes") is True
    assert parse_bool("no") is False
    assert parse_bool(None) is None
    assert parse_bool("") is None
    # 'unknown' must not collapse to False — absent stays absent.
    assert parse_bool("maybe") is None


def test_parse_money_variants():
    assert parse_money("₹5 Lakh") == 500_000
    assert parse_money("INR 1,00,000") == 100_000
    assert parse_money("1.5 crore") == 15_000_000
    assert parse_money("$10,000") == 10_000
    assert parse_money("") is None
    assert parse_money("no prize mentioned") is None


def test_parse_datetime_and_date():
    assert parse_datetime("2026-03-05").year == 2026
    assert parse_datetime("March 2026").month == 3
    assert parse_datetime("March 2026").day == 1
    assert parse_date("2026-03-05").isoformat() == "2026-03-05"
    assert parse_datetime("not a date") is None


def test_parse_date_range_inherits_year_and_splits():
    start, end = parse_date_range("Jan 01 - Jan 05, 2026")
    assert start is not None and start.year == 2026
    assert end is not None and end.month == 1
    start2, end2 = parse_date_range("2026-03-05 to 2026-03-07")
    assert start2.date().isoformat() == "2026-03-05"
    assert end2.date().isoformat() == "2026-03-07"
    assert parse_date_range("ongoing") == (None, None)


def test_as_list_dedupes_and_splits():
    assert as_list("a, b, a") == ["a", "b"]
    assert as_list(["x", "x", ""]) == ["x"]
    assert as_list(None) == []


def test_extract_domain():
    assert extract_domain("https://www.devpost.com/hackathons/x") == "devpost.com"
    assert extract_domain("naukri.com") == "naukri.com"
    assert extract_domain("") is None


def test_freshness_helper_is_stable():
    dt = parse_datetime("2026-03-05T00:00:00Z")
    assert dt is not None and dt.tzinfo is not None
    assert dt < datetime.now(timezone.utc)
