"""Unit tests for the GLiNER layer's precision calibration (no model load).

The org designator gate, stoplist, and per-label floors are the precision layer;
the full model integration is covered by benchmarks/pii-accuracy.
"""

from detector.gliner_layer import _MAX_TOKENS, _ORG_DESIGNATOR, _STOPWORDS, PER_LABEL_FLOOR, _windows


def test_org_designator_matches_real_company_forms():
    for org in (
        "Muster Steuerberatung GmbH",
        "Studio Bianchi S.r.l.",
        "Globex Corporation",
        "Acme Holding AG",
        "Rossi e Associati",
        "Sparkasse Köln",
    ):
        assert _ORG_DESIGNATOR.search(org), org


def test_org_designator_rejects_brandlike_noun_phrase():
    # The benchmark's it_fp false positive: a brand-ambiguous phrase with no
    # legal-form designator must not qualify as an organization.
    for not_org in ("Il caffè italiano", "the weather", "der Mandant"):
        assert not _ORG_DESIGNATOR.search(not_org), not_org


def test_stoplist_has_common_false_positive_words():
    for w in ("ich", "lieferung", "rechnung", "der mandant", "sede legale"):
        assert w in _STOPWORDS


def test_windows_single_for_short_text():
    text = "Mario Rossi lives in Rome."
    assert list(_windows(text)) == [(0, text)]


def test_windows_overlapping_and_cover_long_text():
    # > _MAX_TOKENS word-tokens -> multiple windows that slice the original text
    # correctly and reach the end (so trailing PII is never dropped).
    text = " ".join(f"word{i}" for i in range(_MAX_TOKENS * 4))
    wins = list(_windows(text))
    assert len(wins) > 1
    for off, sub in wins:
        assert text[off : off + len(sub)] == sub
    last_off, last_sub = wins[-1]
    assert last_off + len(last_sub) == len(text)


def test_per_label_floors_present_and_ordered():
    assert set(PER_LABEL_FLOOR) == {"person", "location", "organization", "address"}
    # Org is the strictest (brand-ambiguous), address the most permissive (faint).
    assert PER_LABEL_FLOOR["organization"] >= PER_LABEL_FLOOR["person"]
    assert PER_LABEL_FLOOR["address"] <= PER_LABEL_FLOOR["person"]
