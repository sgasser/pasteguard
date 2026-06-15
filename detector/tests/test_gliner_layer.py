"""Unit tests for the GLiNER layer's precision calibration (no model load).

The org designator gate, stoplist, and per-label floors are the precision layer;
the full model integration is covered by benchmarks/pii-accuracy.
"""

from detector.gliner_layer import _ORG_DESIGNATOR, _STOPWORDS, PER_LABEL_FLOOR


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


def test_per_label_floors_present_and_ordered():
    assert set(PER_LABEL_FLOOR) == {"person", "location", "organization", "address"}
    # Org is the strictest (brand-ambiguous), address the most permissive (faint).
    assert PER_LABEL_FLOOR["organization"] >= PER_LABEL_FLOOR["person"]
    assert PER_LABEL_FLOOR["address"] <= PER_LABEL_FLOOR["person"]
