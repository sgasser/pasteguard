"""Model loading and inference for the OpenAI Privacy Filter backend."""

from __future__ import annotations

import json
import math
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download
from huggingface_hub.errors import (
    HfHubHTTPError,
    LocalEntryNotFoundError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
)

from .entities import Span
from .openai_privacy_filter_decoder import (
    VITERBI_BIAS_KEYS,
    TokenPrediction,
    consolidate_candidates,
    default_viterbi_biases,
    reconstruct_window,
    viterbi_decode,
)
from .openai_privacy_filter_labels import validate_label_set

DEFAULT_MODEL = "openai/privacy-filter"
_MAX_STRIDE_TOKENS = 128
_UNBOUNDED_MODEL_LENGTH = 1_000_000_000
_VITERBI_CALIBRATION = "viterbi_calibration.json"

_tokenizer: Any = None
_model: Any = None
_id2label: dict[int, str] = {}
_loaded_model_name: str | None = None
_viterbi_biases = default_viterbi_biases()
_load_lock = threading.Lock()
# Torch inference is not guaranteed thread-safe.
_infer_lock = threading.Lock()


def _read_viterbi_biases(path: Path, model_name: str) -> dict[str, float]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        biases = payload["operating_points"]["default"]["biases"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: {exc}"
        ) from exc
    if not isinstance(biases, Mapping) or set(biases) != set(VITERBI_BIAS_KEYS):
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: "
            f"biases must contain exactly {', '.join(VITERBI_BIAS_KEYS)}"
        )

    normalized: dict[str, float] = {}
    for key in VITERBI_BIAS_KEYS:
        value = biases[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(
                f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: "
                f"{key} must be numeric"
            )
        normalized[key] = float(value)
        if not math.isfinite(normalized[key]):
            raise ValueError(
                f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: "
                f"{key} must be finite"
            )
    return normalized


def _load_viterbi_biases(model_name: str) -> dict[str, float]:
    default = default_viterbi_biases()
    try:
        model_path = Path(model_name).expanduser()
    except RuntimeError:
        model_path = Path(model_name)

    if model_path.is_dir():
        calibration_path = model_path / _VITERBI_CALIBRATION
        if not calibration_path.is_file():
            return default
    else:
        try:
            calibration_path = Path(hf_hub_download(model_name, _VITERBI_CALIBRATION))
        except (
            HfHubHTTPError,
            LocalEntryNotFoundError,
            RemoteEntryNotFoundError,
            RepositoryNotFoundError,
        ):
            return default
    return _read_viterbi_biases(calibration_path, model_name)


def _create_components(model_name: str) -> tuple[Any, Any, dict[str, float]]:
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_name, use_fast=True)
    if not tokenizer.is_fast:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} requires a fast tokenizer to preserve character offsets"
        )
    model = AutoModelForTokenClassification.from_pretrained(model_name)
    model.eval()
    return tokenizer, model, _load_viterbi_biases(model_name)


def load_model(model_name: str = DEFAULT_MODEL) -> None:
    """Load and validate one Privacy Filter checkpoint exactly once."""

    global _id2label, _loaded_model_name, _model, _tokenizer, _viterbi_biases
    if _model is not None:
        if _loaded_model_name != model_name:
            loaded = _loaded_model_name or "an unknown checkpoint"
            raise RuntimeError(
                f"OpenAI Privacy Filter is already loaded with {loaded!r}; "
                f"cannot load {model_name!r}"
            )
        return

    with _load_lock:
        if _model is not None:
            if _loaded_model_name != model_name:
                loaded = _loaded_model_name or "an unknown checkpoint"
                raise RuntimeError(
                    f"OpenAI Privacy Filter is already loaded with {loaded!r}; "
                    f"cannot load {model_name!r}"
                )
            return

        tokenizer, model, viterbi_biases = _create_components(model_name)
        labels = validate_label_set(
            getattr(getattr(model, "config", None), "id2label", None),
            model_name,
        )
        _tokenizer = tokenizer
        _model = model
        _id2label = labels
        _viterbi_biases = viterbi_biases
        _loaded_model_name = model_name


def _model_max_tokens() -> int:
    tokenizer_limit = getattr(_tokenizer, "model_max_length", None)
    model_limit = getattr(getattr(_model, "config", None), "max_position_embeddings", None)
    limits: list[int] = []
    for raw_limit in (tokenizer_limit, model_limit):
        if raw_limit is None or isinstance(raw_limit, bool):
            continue
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError, OverflowError):
            continue
        if 1 < limit < _UNBOUNDED_MODEL_LENGTH:
            limits.append(limit)
    if not limits:
        raise ValueError("OpenAI Privacy Filter tokenizer has no finite model_max_length")
    return min(limits)


def _inference_stride(max_tokens: int) -> int:
    try:
        special_tokens = int(_tokenizer.num_special_tokens_to_add(pair=False))
    except (AttributeError, TypeError, ValueError, OverflowError):
        special_tokens = 0
    content_tokens = max_tokens - max(0, special_tokens)
    if content_tokens < 2:
        raise ValueError(
            "OpenAI Privacy Filter tokenizer model_max_length is too small for inference"
        )
    return min(_MAX_STRIDE_TOKENS, max(1, content_tokens // 4))


def _as_windows(value: object) -> list[list[Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    items = list(value)
    if not items:
        return []
    first = items[0]
    if isinstance(first, Sequence) and not isinstance(first, (str, bytes)):
        return [list(item) for item in items if isinstance(item, Sequence)]
    return [items]


def _finite_score(value: object) -> float | None:
    try:
        score = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(score):
        return None
    return min(1.0, max(0.0, score))


def _offset_pair(value: object) -> tuple[int, int] | None:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 2:
        return None
    raw_start, raw_end = value
    if isinstance(raw_start, bool) or isinstance(raw_end, bool):
        return None
    try:
        start = int(raw_start)
        end = int(raw_end)
    except (TypeError, ValueError, OverflowError):
        return None
    if raw_start != start or raw_end != end:
        return None
    return start, end


def _predict_windows(text: str) -> list[list[TokenPrediction]]:
    import torch

    max_tokens = _model_max_tokens()
    stride = _inference_stride(max_tokens)
    encoded = _tokenizer(
        text,
        truncation=True,
        max_length=max_tokens,
        stride=stride,
        return_overflowing_tokens=True,
        return_offsets_mapping=True,
        return_special_tokens_mask=True,
        padding=False,
    )

    input_windows = _as_windows(encoded.get("input_ids"))
    attention_windows = _as_windows(encoded.get("attention_mask"))
    offset_windows = _as_windows(encoded.get("offset_mapping"))
    special_windows = _as_windows(encoded.get("special_tokens_mask"))
    if not input_windows or len(offset_windows) != len(input_windows):
        raise RuntimeError("OpenAI Privacy Filter tokenizer did not return character offsets")

    try:
        device = next(_model.parameters()).device
    except (AttributeError, StopIteration, TypeError):
        device = None

    predictions: list[list[TokenPrediction]] = []
    for window_index, input_ids in enumerate(input_windows):
        attention = (
            attention_windows[window_index]
            if window_index < len(attention_windows)
            else [1] * len(input_ids)
        )
        offsets = offset_windows[window_index]
        special = (
            special_windows[window_index]
            if window_index < len(special_windows)
            else [0] * len(input_ids)
        )
        tensor_kwargs = {"device": device} if device is not None else {}
        model_inputs = {
            "input_ids": torch.tensor([input_ids], **tensor_kwargs),
            "attention_mask": torch.tensor([attention], **tensor_kwargs),
        }
        with torch.inference_mode():
            output = _model(**model_inputs)
            logits = output["logits"] if isinstance(output, Mapping) else output.logits

        token_count = min(
            len(input_ids),
            len(attention),
            len(offsets),
            len(special),
            len(logits[0]),
        )
        active_tokens: list[tuple[int, int, int]] = []
        for token_index in range(token_count):
            if not bool(attention[token_index]) or bool(special[token_index]):
                continue
            offset = _offset_pair(offsets[token_index])
            if offset is None:
                continue
            start, end = offset
            if 0 <= start < end <= len(text):
                active_tokens.append((token_index, start, end))

        if not active_tokens:
            predictions.append([])
            continue

        log_probabilities = logits[0].float().log_softmax(dim=-1)
        active_log_probabilities = log_probabilities[
            [token_index for token_index, _, _ in active_tokens]
        ]
        label_ids = viterbi_decode(active_log_probabilities, _id2label, _viterbi_biases)
        probabilities = active_log_probabilities.exp()
        window_predictions: list[TokenPrediction] = []
        for prediction_index, ((_, start, end), label_id) in enumerate(
            zip(active_tokens, label_ids, strict=True)
        ):
            label = _id2label.get(label_id)
            score = _finite_score(probabilities[prediction_index, label_id])
            if label is not None and score is not None:
                window_predictions.append(TokenPrediction(label, start, end, score))
        predictions.append(window_predictions)
    return predictions


def detect_openai_privacy_filter(text: str, score_threshold: float = 0.0) -> list[Span]:
    if not text:
        return []
    if _model is None or _tokenizer is None:
        raise RuntimeError(
            "OpenAI Privacy Filter model not loaded; load_semantic_backend() selects and loads it"
        )

    with _infer_lock:
        windows = _predict_windows(text)

    candidates = consolidate_candidates(
        [
            candidate
            for predictions in windows
            for candidate in reconstruct_window(predictions, len(text))
        ]
    )

    spans: list[Span] = []
    for candidate in candidates:
        start, end = candidate.start, candidate.end
        while start < end and text[start].isspace():
            start += 1
        while start < end and text[end - 1].isspace():
            end -= 1
        if start < end and candidate.score >= score_threshold:
            spans.append(Span(candidate.entity_type, start, end, candidate.score))
    return spans
