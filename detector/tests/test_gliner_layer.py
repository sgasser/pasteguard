"""Unit tests for the GLiNER layer's precision calibration (no model load).

Full model integration is covered by benchmarks/pii-accuracy.
"""

from unittest.mock import Mock

import pytest

import detector.gliner_layer as layer
from detector.gliner_layer import (
    _MAX_TOKENS,
    _TOKEN_RE,
    PER_LABEL_FLOOR,
    Span,
    _floor,
    _max_tokens,
    _windows,
    detect_gliner,
    load_model,
)


def test_token_re_matches_gliner_splitter():
    # Windowing correctness depends on our token regex matching GLiNER's own
    # splitter exactly; pin it so a GLiNER change to the pattern fails here
    # instead of silently truncating long inputs past the token limit.
    try:
        from gliner.data_processing.tokenizer import WhitespaceTokenSplitter
    except Exception:
        pytest.skip("gliner WhitespaceTokenSplitter not importable")
    assert _TOKEN_RE.pattern == WhitespaceTokenSplitter().whitespace_pattern.pattern


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
    assert set(PER_LABEL_FLOOR) == {"person", "location", "address"}
    assert all(0.0 <= v <= 1.0 for v in PER_LABEL_FLOOR.values())
    assert PER_LABEL_FLOOR["person"] == 0.99
    # Person carries a stricter floor than location: higher volume and no
    # structural validator, so a higher floor curbs false positives.
    assert PER_LABEL_FLOOR["location"] <= PER_LABEL_FLOOR["person"]


def test_gliner_loads_selected_model_once(monkeypatch):
    from gliner import GLiNER

    loaded_model = object()
    from_pretrained = Mock(return_value=loaded_model)
    monkeypatch.setattr(layer, "_model", None)
    monkeypatch.setattr(layer, "_loaded_model_name", None)
    monkeypatch.setattr(GLiNER, "from_pretrained", from_pretrained)

    load_model("org/custom-gliner")
    load_model("org/custom-gliner")

    from_pretrained.assert_called_once_with("org/custom-gliner")
    assert layer._model is loaded_model


def test_gliner_rejects_different_model_after_loading(monkeypatch):
    monkeypatch.setattr(layer, "_model", object())
    monkeypatch.setattr(layer, "_loaded_model_name", "org/already-loaded")

    with pytest.raises(
        RuntimeError,
        match=("GLiNER is already loaded with 'org/already-loaded'; cannot load 'org/different'"),
    ):
        load_model("org/different")


def test_detect_requires_loaded_model(monkeypatch):
    monkeypatch.setattr(layer, "_model", None)

    with pytest.raises(RuntimeError, match="GLiNER model not loaded"):
        detect_gliner("Alice", 0.0)


def test_floor_env_defaults(monkeypatch):
    monkeypatch.delenv("GLINER_FLOOR_PERSON", raising=False)
    monkeypatch.delenv("DETECTOR_FLOOR_PERSON", raising=False)

    assert _floor("person", 0.99) == 0.99


def test_gliner_floor_env_wins_over_existing_legacy_name(monkeypatch):
    monkeypatch.setenv("GLINER_FLOOR_PERSON", "0.91")
    monkeypatch.setenv("DETECTOR_FLOOR_PERSON", "0.50")

    assert _floor("person", 0.99) == 0.91


def test_existing_floor_env_remains_supported(monkeypatch):
    monkeypatch.delenv("GLINER_FLOOR_PERSON", raising=False)
    monkeypatch.setenv("DETECTOR_FLOOR_PERSON", "0.90")

    assert _floor("person", 0.99) == 0.90


def test_invalid_existing_floor_env_names_the_source(monkeypatch):
    monkeypatch.delenv("GLINER_FLOOR_PERSON", raising=False)
    monkeypatch.setenv("DETECTOR_FLOOR_PERSON", "bad")

    with pytest.raises(
        ValueError,
        match="DETECTOR_FLOOR_PERSON must be a number between 0 and 1",
    ):
        _floor("person", 0.99)


@pytest.mark.parametrize("value", ["bad", "-0.1", "1.1", "nan", "inf"])
def test_invalid_gliner_floor_fails_clearly(monkeypatch, value):
    monkeypatch.setenv("GLINER_FLOOR_PERSON", value)

    with pytest.raises(ValueError, match="GLINER_FLOOR_PERSON must be a number between 0 and 1"):
        _floor("person", 0.99)


def test_gliner_calls_model_with_only_emitted_semantic_labels(monkeypatch):
    text = "No personal data is present."
    mock_gliner = Mock()
    mock_gliner.predict_entities.return_value = []
    monkeypatch.setattr(layer, "_model", mock_gliner)
    layer._predict_window.cache_clear()

    assert detect_gliner(text, 0.0) == []

    labels = mock_gliner.predict_entities.call_args.args[1]
    assert labels == ["person", "location", "address"]


def test_detect_does_not_suppress_emitted_semantic_labels(monkeypatch):
    monkeypatch.setattr(layer, "_model", Mock())
    monkeypatch.setattr(
        layer,
        "_predict_window",
        lambda _text: [
            {"start": 0, "end": 5, "label": "person", "score": 0.995},
            {"start": 0, "end": 5, "label": "location", "score": 1.0},
        ],
    )

    assert detect_gliner("Alice", 0.0) == [
        Span(entity_type="PERSON", start=0, end=5, score=0.995),
        Span(entity_type="LOCATION", start=0, end=5, score=1.0),
    ]


def test_max_tokens_env_defaults(monkeypatch):
    monkeypatch.delenv("GLINER_MAX_TOKENS", raising=False)
    monkeypatch.delenv("DETECTOR_MAX_TOKENS", raising=False)

    assert _max_tokens() == 384


def test_gliner_max_tokens_env_wins_over_existing_legacy_name(monkeypatch):
    monkeypatch.setenv("GLINER_MAX_TOKENS", "512")
    monkeypatch.setenv("DETECTOR_MAX_TOKENS", "256")

    assert _max_tokens() == 512


def test_existing_max_tokens_env_remains_supported(monkeypatch):
    monkeypatch.delenv("GLINER_MAX_TOKENS", raising=False)
    monkeypatch.setenv("DETECTOR_MAX_TOKENS", "256")

    assert _max_tokens() == 256


def test_invalid_existing_max_tokens_env_names_the_source(monkeypatch):
    monkeypatch.delenv("GLINER_MAX_TOKENS", raising=False)
    monkeypatch.setenv("DETECTOR_MAX_TOKENS", "many")

    with pytest.raises(
        ValueError,
        match="DETECTOR_MAX_TOKENS must be an integer of at least 64",
    ):
        _max_tokens()


@pytest.mark.parametrize("value", ["63", "384.5", "many"])
def test_invalid_gliner_max_tokens_fails_clearly(monkeypatch, value):
    monkeypatch.setenv("GLINER_MAX_TOKENS", value)

    with pytest.raises(ValueError, match="GLINER_MAX_TOKENS must be an integer of at least 64"):
        _max_tokens()


def test_window_inference_cache(monkeypatch):
    repeated_text = "This is going to repeat, don't waste resources more than once!"
    cache_missed_text = "This appears for the first time, it will increase the model call count."

    mock_predictions = {
        repeated_text: [{"start": 0, "end": 1, "label": "person", "score": 1.0}],
        cache_missed_text: [{"start": 0, "end": 1, "label": "person", "score": 1.0}],
    }

    mock_gliner = Mock()
    mock_gliner.predict_entities.side_effect = lambda text, *_, **__: mock_predictions[text]
    monkeypatch.setattr("detector.gliner_layer._model", mock_gliner)

    expected = [
        Span(
            entity_type="PERSON",
            start=0,
            end=1,
            score=1.0,
        )
    ]

    assert detect_gliner(cache_missed_text, 0.0) == expected

    for _ in range(5):
        assert detect_gliner(repeated_text, 0.0) == expected

    # Hits once for the original cache miss, and only once more for the repeated content
    assert mock_gliner.predict_entities.call_count == 2
