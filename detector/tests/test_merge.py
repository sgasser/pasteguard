"""Unit tests for the merge / conflict-resolution layer."""

from detector.entities import IBAN_CODE, LOCATION, PERSON, Span
from detector.merge import merge


def test_deterministic_precedence_over_overlapping_fuzzy():
    det = [Span(IBAN_CODE, 0, 27, 1.0)]
    fuzzy = [Span(LOCATION, 0, 4, 0.9)]  # e.g. "DE89" mis-tagged
    out = merge(det, fuzzy, None, 0.7)
    assert out == [Span(IBAN_CODE, 0, 27, 1.0)]


def test_fuzzy_below_threshold_dropped():
    out = merge([], [Span(PERSON, 0, 5, 0.5)], None, 0.7)
    assert out == []


def test_fuzzy_above_threshold_kept():
    out = merge([], [Span(PERSON, 0, 5, 0.8)], None, 0.7)
    assert out == [Span(PERSON, 0, 5, 0.8)]


def test_deterministic_always_passes_threshold():
    # score 1.0 >= any threshold <= 1
    out = merge([Span(IBAN_CODE, 0, 4, 1.0)], [], None, 1.0)
    assert out == [Span(IBAN_CODE, 0, 4, 1.0)]


def test_entity_filter():
    det = [Span(IBAN_CODE, 0, 4, 1.0)]
    fuzzy = [Span(PERSON, 10, 15, 0.9)]
    out = merge(det, fuzzy, [PERSON], 0.7)
    assert out == [Span(PERSON, 10, 15, 0.9)]


def test_fuzzy_overlap_longest_wins():
    fuzzy = [Span(PERSON, 0, 5, 0.8), Span(PERSON, 0, 10, 0.8)]
    out = merge([], fuzzy, None, 0.7)
    assert out == [Span(PERSON, 0, 10, 0.8)]


def test_result_sorted_by_start():
    det = [Span(IBAN_CODE, 20, 30, 1.0)]
    fuzzy = [Span(PERSON, 0, 5, 0.9)]
    out = merge(det, fuzzy, None, 0.7)
    assert [s.start for s in out] == [0, 20]


def test_non_overlapping_both_kept():
    det = [Span(IBAN_CODE, 0, 4, 1.0)]
    fuzzy = [Span(PERSON, 10, 15, 0.9)]
    out = merge(det, fuzzy, None, 0.7)
    assert len(out) == 2


def test_requested_entity_not_suppressed_by_non_requested_overlap():
    # A longer non-requested span must not win the overlap and then be filtered
    # out, which would drop the requested (shorter) span entirely. e.g. a longer
    # LOCATION span overlapping the PERSON span when only PERSON is requested.
    fuzzy = [Span(PERSON, 0, 11, 0.9), Span(LOCATION, 0, 15, 0.85)]
    out = merge([], fuzzy, [PERSON], 0.0)
    assert out == [Span(PERSON, 0, 11, 0.9)]
