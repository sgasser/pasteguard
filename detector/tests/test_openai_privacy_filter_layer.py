"""Unit tests for the OpenAI Privacy Filter backend (no model downloads)."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import detector.openai_privacy_filter_layer as layer
from detector.entities import (
    ACCOUNT_NUMBER,
    CREDIT_CARD,
    DATE_TIME,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    LOCATION,
    PERSON,
    PHONE_NUMBER,
    SECRET,
    URL,
    Span,
)
from detector.openai_privacy_filter_decoder import (
    VITERBI_BIAS_KEYS,
    TokenPrediction,
    default_viterbi_biases,
    viterbi_decode,
)
from detector.openai_privacy_filter_labels import REQUIRED_LABELS, validate_label_set


@pytest.fixture(autouse=True)
def reset_backend(monkeypatch):
    monkeypatch.setattr(layer, "_tokenizer", None)
    monkeypatch.setattr(layer, "_model", None)
    monkeypatch.setattr(layer, "_id2label", {})
    monkeypatch.setattr(layer, "_loaded_model_name", None)
    monkeypatch.setattr(layer, "_inference_max_tokens", layer._DEFAULT_MAX_TOKENS)
    monkeypatch.setattr(
        layer,
        "_viterbi_biases",
        default_viterbi_biases(),
    )
    layer._candidate_cache.clear()


def _checkpoint_labels(boundaries: str = "BIES", extras: tuple[str, ...] = ()) -> list[str]:
    return [
        "O",
        *[f"{boundary}-{label}" for label in sorted(REQUIRED_LABELS) for boundary in boundaries],
        *extras,
    ]


def _model_with_labels(labels: list[str]):
    model = Mock()
    model.config.id2label = dict(enumerate(labels))
    model.eval = Mock()
    return model


def _token(label: str, start: int, end: int, score: float = 0.9):
    return TokenPrediction(label, start, end, score)


def _loaded_stub(monkeypatch, windows):
    assert len(windows) == 1
    monkeypatch.setattr(layer, "_tokenizer", Mock())
    monkeypatch.setattr(layer, "_model", Mock())
    predict = Mock(return_value=windows[0])
    monkeypatch.setattr(layer, "_predict_tokens", predict)
    return predict


def test_loads_and_validates_checkpoint_once(monkeypatch):
    tokenizer = Mock(is_fast=True)
    model = _model_with_labels(_checkpoint_labels())
    biases = default_viterbi_biases()
    create = Mock(return_value=(tokenizer, model, biases))
    monkeypatch.setattr(layer, "_create_components", create)

    layer.load_model("/models/privacy-filter")
    layer.load_model("/models/privacy-filter")

    create.assert_called_once_with("/models/privacy-filter")
    assert layer._tokenizer is tokenizer
    assert layer._model is model
    assert layer._viterbi_biases == biases


def test_loaded_checkpoint_cannot_be_replaced(monkeypatch):
    tokenizer = Mock(is_fast=True)
    model = _model_with_labels(_checkpoint_labels())
    biases = default_viterbi_biases()
    monkeypatch.setattr(
        layer,
        "_create_components",
        Mock(return_value=(tokenizer, model, biases)),
    )

    layer.load_model("openai/privacy-filter")

    with pytest.raises(RuntimeError, match="already loaded"):
        layer.load_model("org/another-privacy-filter")


def test_configured_max_tokens_can_be_overridden(monkeypatch):
    monkeypatch.setenv("OPENAI_PRIVACY_FILTER_MAX_TOKENS", "1024")

    assert layer._configured_max_tokens() == 1024


@pytest.mark.parametrize("value", ["invalid", "255"])
def test_invalid_configured_max_tokens_fail_clearly(monkeypatch, value):
    monkeypatch.setenv("OPENAI_PRIVACY_FILTER_MAX_TOKENS", value)

    with pytest.raises(ValueError, match="must be an integer of at least 256"):
        layer._configured_max_tokens()


@pytest.mark.parametrize("boundaries", ["BI", "BIES"])
def test_complete_bio_and_bioes_label_sets_are_accepted(boundaries):
    labels = _checkpoint_labels(boundaries)

    normalized = validate_label_set(dict(enumerate(labels)), "compatible/model")

    assert normalized[0] == "O"
    assert set(normalized.values()) == set(labels)


def test_bilou_required_labels_fail_at_startup():
    labels = _checkpoint_labels("BILU")

    with pytest.raises(ValueError, match=r"unsupported boundary prefixes.*L,U"):
        validate_label_set(dict(enumerate(labels)), "org/bilou")


def test_bilou_recognized_aliases_fail_at_startup():
    labels = _checkpoint_labels(extras=("B-person", "I-person", "L-person", "U-person"))

    with pytest.raises(ValueError, match=r"unsupported boundary prefixes.*person=L,U"):
        validate_label_set(dict(enumerate(labels)), "org/bilou-alias")


def test_incompatible_generic_ner_checkpoint_fails_clearly():
    labels = ["O", "B-PER", "I-PER", "B-LOC", "I-LOC"]

    with pytest.raises(ValueError, match="not a Privacy Filter-compatible checkpoint"):
        validate_label_set(dict(enumerate(labels)), "dslim/bert-base-NER")


def test_incomplete_boundary_scheme_fails_clearly():
    labels = _checkpoint_labels()
    labels.remove("S-secret")

    with pytest.raises(ValueError, match=r"incomplete BIO/BIOES boundaries.*secret=B,E,I"):
        validate_label_set(dict(enumerate(labels)), "org/incomplete")


def test_extra_unsupported_labels_are_allowed():
    labels = _checkpoint_labels(
        extras=("B-organization", "I-organization", "L-organization", "U-organization")
    )

    normalized = validate_label_set(dict(enumerate(labels)), "org/extended")

    assert "B-organization" in normalized.values()
    assert "U-organization" in normalized.values()


def test_viterbi_replaces_an_invalid_independent_argmax_path():
    torch = pytest.importorskip("torch")
    id2label = {
        0: "O",
        1: "B-private_person",
        2: "I-private_person",
        3: "E-private_person",
        4: "S-private_person",
    }
    log_probabilities = torch.tensor(
        [
            [0.0, 9.0, 10.0, 0.0, 0.0],
            [10.0, 0.0, 0.0, 9.0, 0.0],
        ]
    )

    assert log_probabilities.argmax(dim=-1).tolist() == [2, 0]
    assert viterbi_decode(log_probabilities, id2label, default_viterbi_biases()) == [1, 3]


def test_viterbi_supports_complete_bio_checkpoints():
    torch = pytest.importorskip("torch")
    id2label = {
        0: "O",
        1: "B-private_person",
        2: "I-private_person",
    }
    log_probabilities = torch.tensor(
        [
            [0.0, 9.0, 10.0],
            [10.0, 0.0, 1.0],
        ]
    )

    assert viterbi_decode(log_probabilities, id2label, default_viterbi_biases()) == [1, 0]


def test_local_viterbi_calibration_is_loaded(tmp_path):
    biases = {key: index / 10 for index, key in enumerate(VITERBI_BIAS_KEYS, start=1)}
    (tmp_path / "viterbi_calibration.json").write_text(
        json.dumps({"operating_points": {"default": {"biases": biases}}})
    )

    assert layer._load_viterbi_biases(str(tmp_path)) == biases


def test_invalid_local_viterbi_calibration_fails_clearly(tmp_path):
    (tmp_path / "viterbi_calibration.json").write_text(
        json.dumps({"operating_points": {"default": {"biases": {}}}})
    )

    with pytest.raises(ValueError, match=r"viterbi_calibration\.json"):
        layer._load_viterbi_biases(str(tmp_path))


def test_empty_text_does_not_require_loaded_model():
    assert layer.detect_openai_privacy_filter("", 0.7) == []


def test_non_empty_text_requires_loaded_model():
    with pytest.raises(RuntimeError, match="not loaded"):
        layer.detect_openai_privacy_filter("Alice", 0.7)


def test_native_labels_map_to_canonical_entity_types(monkeypatch):
    labels = [
        ("account_number", ACCOUNT_NUMBER),
        ("private_address", LOCATION),
        ("private_date", DATE_TIME),
        ("private_email", EMAIL_ADDRESS),
        ("private_person", PERSON),
        ("private_phone", PHONE_NUMBER),
        ("private_url", URL),
        ("secret", SECRET),
    ]
    text = " ".join("xx" for _ in labels)
    windows = [
        [
            _token(f"S-{native}", index * 3, index * 3 + 2)
            for index, (native, _) in enumerate(labels)
        ]
    ]
    _loaded_stub(monkeypatch, windows)

    spans = layer.detect_openai_privacy_filter(text)

    assert [span.entity_type for span in spans] == [canonical for _, canonical in labels]


def test_recognized_fine_tune_aliases_map_to_existing_canonical_types(monkeypatch):
    aliases = [
        ("credit_card", CREDIT_CARD),
        ("iban_code", IBAN_CODE),
        ("ip_address", IP_ADDRESS),
    ]
    text = "xx xx xx"
    _loaded_stub(
        monkeypatch,
        [
            [
                _token(f"S-{native}", index * 3, index * 3 + 2)
                for index, (native, _) in enumerate(aliases)
            ]
        ],
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert [span.entity_type for span in spans] == [canonical for _, canonical in aliases]


def test_bio_reconstruction_merges_subwords_and_preserves_offsets(monkeypatch):
    text = "Say Alice Smith today"
    _loaded_stub(
        monkeypatch,
        [
            [
                _token("O", 0, 3),
                _token("B-private_person", 4, 6, 0.8),
                _token("I-private_person", 6, 9, 0.9),
                _token("I-private_person", 10, 15, 1.0),
                _token("O", 16, 21),
            ]
        ],
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert spans == [Span(PERSON, 4, 15, 0.9)]
    assert text[spans[0].start : spans[0].end] == "Alice Smith"


def test_bioes_reconstruction_handles_single_and_complete_spans(monkeypatch):
    text = "Alice met Bob Stone"
    _loaded_stub(
        monkeypatch,
        [
            [
                _token("S-private_person", 0, 5, 0.95),
                _token("O", 6, 9),
                _token("B-private_person", 10, 13, 0.8),
                _token("E-private_person", 14, 19, 1.0),
            ]
        ],
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert spans == [
        Span(PERSON, 0, 5, 0.95),
        Span(PERSON, 10, 19, 0.9),
    ]


def test_adjacent_complete_person_spans_remain_separate(monkeypatch):
    text = "Alice Smith Bob Jones"
    _loaded_stub(
        monkeypatch,
        [
            [
                _token("B-private_person", 0, 5, 0.95),
                _token("E-private_person", 5, 11, 0.95),
                _token("B-private_person", 11, 15, 0.96),
                _token("E-private_person", 15, 21, 0.96),
            ]
        ],
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert spans == [
        Span(PERSON, 0, 11, 0.95),
        Span(PERSON, 12, 21, 0.96),
    ]


def test_unsupported_labels_are_deliberately_ignored(monkeypatch):
    text = "Alice at Acme Bob"
    _loaded_stub(
        monkeypatch,
        [
            [
                _token("S-private_person", 0, 5),
                _token("B-organization", 9, 11),
                _token("I-organization", 11, 13),
                _token("S-private_person", 14, 17),
            ]
        ],
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert spans == [
        Span(PERSON, 0, 5, 0.9),
        Span(PERSON, 14, 17, 0.9),
    ]


def test_score_threshold_applies_after_complete_span_reconstruction(monkeypatch):
    text = "Alice"
    _loaded_stub(
        monkeypatch,
        [[_token("B-private_person", 0, 2, 0.6), _token("E-private_person", 2, 5, 1.0)]],
    )

    assert layer.detect_openai_privacy_filter(text, 0.79) == [Span(PERSON, 0, 5, 0.8)]
    assert layer.detect_openai_privacy_filter(text, 0.81) == []


def test_span_whitespace_is_trimmed_after_reconstruction(monkeypatch):
    text = " Alice "
    _loaded_stub(
        monkeypatch,
        [[_token("B-private_person", 0, 3), _token("E-private_person", 3, 7)]],
    )

    assert layer.detect_openai_privacy_filter(text) == [Span(PERSON, 1, 6, 0.9)]


def test_character_offsets_remain_exact_after_astral_unicode(monkeypatch):
    text = "😀 Alice"
    _loaded_stub(monkeypatch, [[_token("S-private_person", 2, 7)]])

    spans = layer.detect_openai_privacy_filter(text)

    assert spans == [Span(PERSON, 2, 7, 0.9)]
    assert text[spans[0].start : spans[0].end] == "Alice"


def test_tokens_with_the_same_unicode_offset_remain_distinct(monkeypatch):
    torch = pytest.importorskip("torch")

    class FakeTokenizer:
        model_max_length = 2048

        def num_special_tokens_to_add(self, pair=False):
            assert pair is False
            return 0

        def __call__(self, _text, **_kwargs):
            return {
                "input_ids": [[10, 11]],
                "attention_mask": [[1, 1]],
                "offset_mapping": [[(0, 1), (0, 1)]],
                "special_tokens_mask": [[0, 0]],
            }

    class FakeModel:
        config = SimpleNamespace(max_position_embeddings=2048)

        def parameters(self):
            yield torch.nn.Parameter(torch.empty(0))

        def __call__(self, **_kwargs):
            return SimpleNamespace(
                logits=torch.tensor([[[8.0, 0.0], [0.0, 8.0]]]),
            )

    monkeypatch.setattr(layer, "_tokenizer", FakeTokenizer())
    monkeypatch.setattr(layer, "_model", FakeModel())
    monkeypatch.setattr(layer, "_id2label", {0: "O", 1: "S-private_person"})

    predictions = layer._predict_tokens("𐍈")

    assert [(prediction.label, prediction.start, prediction.end) for prediction in predictions] == [
        ("O", 0, 1),
        ("S-private_person", 0, 1),
    ]


def test_inference_stitches_overlapping_token_scores_before_global_viterbi(monkeypatch):
    torch = pytest.importorskip("torch")
    text = "x" * 132
    first_ids = list(range(1000, 1130))
    second_ids = [*first_ids[2:], 2000, 2001]
    first_offsets = [(index, index + 1) for index in range(130)]
    second_offsets = [(index, index + 1) for index in range(2, 132)]

    class FakeTokenizer:
        model_max_length = 128000
        is_fast = True

        def __init__(self):
            self.call = Mock()

        def num_special_tokens_to_add(self, pair=False):
            assert pair is False
            return 0

        def __call__(self, text, **kwargs):
            self.call(text, **kwargs)
            return {
                "input_ids": [first_ids, second_ids],
                "attention_mask": [[1] * 130, [1] * 130],
                "offset_mapping": [first_offsets, second_offsets],
                "special_tokens_mask": [[0] * 130, [0] * 130],
            }

    class FakeModel:
        config = SimpleNamespace(max_position_embeddings=131072)

        def __init__(self):
            self.calls = 0

        def parameters(self):
            yield torch.nn.Parameter(torch.empty(0))

        def __call__(self, **_kwargs):
            self.calls += 1
            logits = torch.zeros((1, 130, 3))
            logits[:, :, 0] = 8.0
            entity_start = 128 if self.calls == 1 else 126
            logits[0, entity_start] = torch.tensor([0.0, 10.0, 0.0])
            logits[0, entity_start + 1] = torch.tensor([0.0, 0.0, 10.0])
            return SimpleNamespace(logits=logits)

    tokenizer = FakeTokenizer()
    model = FakeModel()
    monkeypatch.setattr(layer, "_tokenizer", tokenizer)
    monkeypatch.setattr(layer, "_model", model)
    monkeypatch.setattr(
        layer,
        "_id2label",
        {0: "O", 1: "B-private_person", 2: "E-private_person"},
    )

    spans = layer.detect_openai_privacy_filter(text)

    assert len(spans) == 1
    assert spans[0].entity_type == PERSON
    assert (spans[0].start, spans[0].end) == (128, 130)
    assert model.calls == 2
    tokenizer.call.assert_called_once_with(
        text,
        truncation=True,
        max_length=2048,
        stride=128,
        return_overflowing_tokens=True,
        return_offsets_mapping=True,
        return_special_tokens_mask=True,
        padding=False,
    )


def test_repeated_text_reuses_compact_candidate_cache(monkeypatch):
    predict = _loaded_stub(
        monkeypatch,
        [[_token("S-private_person", 0, 5, 0.95)]],
    )

    first = layer.detect_openai_privacy_filter("Alice")
    second = layer.detect_openai_privacy_filter("Alice")

    assert first == second == [Span(PERSON, 0, 5, 0.95)]
    predict.assert_called_once_with("Alice")
