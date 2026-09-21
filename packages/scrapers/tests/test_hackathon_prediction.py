"""Recurrence prediction: evidence-driven, explicit confidence, no fabrication."""
from scrapers.domains.hackathons.prediction import analyze_recurrence


def _occ(year, month=None, day=10):
    return {
        "year": year,
        "event_start": f"{year}-{month:02d}-{day:02d}" if month else None,
        "source_url": f"https://example.com/{year}",
    }


def test_three_annual_occurrences_predict_next_year():
    result = analyze_recurrence([
        _occ(2024, 3, 10), _occ(2025, 3, 12), _occ(2026, 3, 15),
    ])
    assert result is not None
    assert result["predicted_occurrence"].startswith("2027-03")
    assert result["expected_month"] == 3
    assert result["occurrence_type"] == "recurring"
    assert result["historical_observations"] == 3
    assert result["status"] == "PREDICTED"
    assert result["prediction_confidence"] >= 60
    assert "2024" in result["prediction_basis"] and "2026" in result["prediction_basis"]
    assert len(result["evidence"]) == 3
    assert result["method"] and result["limitations"]


def test_single_occurrence_yields_nothing():
    assert analyze_recurrence([_occ(2026, 3)]) is None


def test_two_occurrences_are_low_confidence_never_false_precision():
    result = analyze_recurrence([_occ(2024, 6), _occ(2025, 6)])
    assert result is not None
    # Two data points can never justify a confident prediction.
    assert result["prediction_confidence"] < 70
    # Two points establish a pattern; they never justify a dated prediction.
    assert result["status"] == "RECURRING_PATTERN"


def test_biennial_pattern_uses_interval():
    result = analyze_recurrence([_occ(2022, 5), _occ(2024, 5), _occ(2026, 5)])
    assert result is not None
    assert result["predicted_occurrence"].startswith("2028-05")


def test_year_only_history_predicts_year_without_inventing_month():
    result = analyze_recurrence([{"year": 2023}, {"year": 2024}, {"year": 2025}])
    assert result is not None
    assert result["expected_month"] is None
    assert result["predicted_occurrence"] is None  # no month -> no fabricated date
    assert result["predicted_occurrence"] is None


def test_shifted_month_history_is_recurring_but_not_a_confident_date():
    # Jan 2024 -> Jul 2026 is a real recurrence (2-year cadence) but the month
    # moved, so this must stay a pattern flag, never a published prediction.
    result = analyze_recurrence([_occ(2024, 1), _occ(2026, 7)])
    assert result is not None
    assert result["occurrence_type"] == "recurring"
    assert result["status"] == "RECURRING_PATTERN"
    assert result["prediction_confidence"] < 60
    assert "consistency" in result["prediction_basis"]
