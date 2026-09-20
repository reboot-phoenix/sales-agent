"""
Regression: _merge_lists crashed on legacy scalar JSONB values.

Live 2026-09-20: an enrichment job for a real lead died in
_merge_lists with `TypeError: can only concatenate str (not "list")`
because a JSONB array column (tech_stack/emails) held a bare string.
The job stayed 'running' forever and the consumer kept retrying the
same crash. Merging must coerce scalars instead of raising.
"""
from scrapers.enrichment_worker import _merge_lists


def test_merge_lists_with_scalar_old_value():
    assert _merge_lists("go", ["python", "go"]) == ["go", "python"]


def test_merge_lists_with_scalar_new_value():
    assert _merge_lists(["a@x.com"], "b@x.com") == ["a@x.com", "b@x.com"]


def test_merge_lists_with_nones():
    assert _merge_lists(None, None) == []
    assert _merge_lists(None, ["x"]) == ["x"]
    assert _merge_lists("x", None) == ["x"]


def test_merge_lists_dedupes_and_drops_blanks():
    assert _merge_lists(["a", "", "b"], ["b", "c", ""]) == ["a", "b", "c"]
