"""OpenAI Privacy Filter semantic backend.

The checkpoint emits token-level BIO or BIOES labels. This layer deliberately
does not use Transformers' ``aggregation_strategy="simple"`` because that
aggregator only understands B/I boundaries and treats E/S labels as generic
continuations. Instead, it runs overlapping tokenizer windows and reconstructs
complete spans from the checkpoint's labels while retaining exact tokenizer
character offsets.
"""

from __future__ import annotations

import json
import math
import re
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download
from huggingface_hub.errors import (
    HfHubHTTPError,
    LocalEntryNotFoundError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
)

from .entities import (
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
    VAT_CODE,
    Span,
)

DEFAULT_MODEL = "openai/privacy-filter"
_MAX_STRIDE_TOKENS = 128
_UNBOUNDED_MODEL_LENGTH = 1_000_000_000
_BOUNDARY_RE = re.compile(r"^([BIES])-(.+)$")
_LABEL_RE = re.compile(r"^([^-]+)-(.+)$")
_SUPPORTED_BOUNDARIES = frozenset({"B", "I", "E", "S"})
_VITERBI_CALIBRATION = "viterbi_calibration.json"
_VITERBI_BIAS_KEYS = (
    "transition_bias_background_stay",
    "transition_bias_background_to_start",
    "transition_bias_inside_to_continue",
    "transition_bias_inside_to_end",
    "transition_bias_end_to_background",
    "transition_bias_end_to_start",
)

# The default checkpoint's eight native categories are required for
# compatibility. Extra categories are allowed: recognized aliases are mapped
# below and all other labels are intentionally ignored.
_REQUIRED_LABELS = frozenset(
    {
        "account_number",
        "private_address",
        "private_date",
        "private_email",
        "private_person",
        "private_phone",
        "private_url",
        "secret",
    }
)

_LABEL_TO_TYPE = {
    # Native OpenAI Privacy Filter labels.
    "account_number": ACCOUNT_NUMBER,
    "private_address": LOCATION,
    "private_date": DATE_TIME,
    "private_email": EMAIL_ADDRESS,
    "private_person": PERSON,
    "private_phone": PHONE_NUMBER,
    "private_url": URL,
    "secret": SECRET,
    # Canonical aliases accepted from compatible fine-tunes. These are not
    # emitted as distinct categories by the default checkpoint.
    "person": PERSON,
    "location": LOCATION,
    "email_address": EMAIL_ADDRESS,
    "phone_number": PHONE_NUMBER,
    "credit_card": CREDIT_CARD,
    "iban_code": IBAN_CODE,
    "ip_address": IP_ADDRESS,
    "url": URL,
    "date_time": DATE_TIME,
    "vat_code": VAT_CODE,
}

_tokenizer: Any = None
_model: Any = None
_id2label: dict[int, str] = {}
_loaded_model_name: str | None = None
_viterbi_biases: dict[str, float] = {key: 0.0 for key in _VITERBI_BIAS_KEYS}
_load_lock = threading.Lock()
# Torch inference is not guaranteed thread-safe.
_infer_lock = threading.Lock()


@dataclass(frozen=True)
class _TokenPrediction:
    label: str
    start: int
    end: int
    score: float


@dataclass(frozen=True)
class _Candidate:
    native_label: str
    entity_type: str
    start: int
    end: int
    score: float

    @property
    def length(self) -> int:
        return self.end - self.start


def _normalized_id2label(raw: object) -> dict[int, str]:
    if not isinstance(raw, Mapping):
        return {}

    labels: dict[int, str] = {}
    for raw_id, raw_label in raw.items():
        if isinstance(raw_id, bool) or not isinstance(raw_label, str):
            continue
        try:
            label_id = int(raw_id)
        except (TypeError, ValueError, OverflowError):
            continue
        if label_id < 0 or not raw_label:
            continue
        labels[label_id] = raw_label
    return labels


def validate_label_set(id2label: object, model_name: str) -> dict[int, str]:
    """Validate and normalize a Privacy Filter-compatible label mapping.

    Each required native category must provide either a complete BIO pair or a
    complete BIOES quartet. Additional checkpoint labels are accepted so that
    compatible fine-tunes can extend the taxonomy; unsupported additions are
    ignored at inference.
    """

    labels = _normalized_id2label(id2label)
    raw_names = set(labels.values())
    if "O" not in raw_names:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            "checkpoint: its labels are missing O"
        )

    boundaries: dict[str, set[str]] = {}
    for raw_label in raw_names:
        match = _LABEL_RE.fullmatch(raw_label)
        if match is None:
            continue
        boundary, native_label = match.groups()
        boundaries.setdefault(native_label, set()).add(boundary)

    unsupported_boundaries = sorted(
        (label, tags - _SUPPORTED_BOUNDARIES)
        for label, tags in boundaries.items()
        if label in _LABEL_TO_TYPE and tags - _SUPPORTED_BOUNDARIES
    )
    if unsupported_boundaries:
        details = ", ".join(
            f"{label}={','.join(sorted(tags))}" for label, tags in unsupported_boundaries
        )
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: unsupported boundary prefixes ({details}); "
            "expected BIO or BIOES labels"
        )

    missing = sorted(_REQUIRED_LABELS - boundaries.keys())
    if missing:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: its labels are missing {', '.join(missing)}"
        )

    invalid_schemes = sorted(
        label
        for label in _REQUIRED_LABELS
        if boundaries[label] not in ({"B", "I"}, _SUPPORTED_BOUNDARIES)
    )
    if invalid_schemes:
        details = ", ".join(
            f"{label}={','.join(sorted(boundaries[label]))}" for label in invalid_schemes
        )
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} is not a Privacy Filter-compatible "
            f"checkpoint: incomplete BIO/BIOES boundaries ({details})"
        )
    return labels


def _read_viterbi_biases(path: Path, model_name: str) -> dict[str, float]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        biases = payload["operating_points"]["default"]["biases"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: {exc}"
        ) from exc
    if not isinstance(biases, Mapping) or set(biases) != set(_VITERBI_BIAS_KEYS):
        raise ValueError(
            f"DETECTOR_MODEL {model_name!r} has an invalid {_VITERBI_CALIBRATION}: "
            f"biases must contain exactly {', '.join(_VITERBI_BIAS_KEYS)}"
        )

    normalized: dict[str, float] = {}
    for key in _VITERBI_BIAS_KEYS:
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
    default: dict[str, float] = {key: 0.0 for key in _VITERBI_BIAS_KEYS}
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


def _label_state(raw_label: str) -> tuple[str | None, str | None]:
    match = _BOUNDARY_RE.fullmatch(raw_label)
    if match is None:
        return None, None
    boundary, native_label = match.groups()
    if native_label not in _LABEL_TO_TYPE:
        return None, None
    return boundary, native_label


def _transition_bias(
    previous: tuple[str | None, str | None],
    following: tuple[str | None, str | None],
    boundaries: Mapping[str, set[str]],
) -> float | None:
    previous_boundary, previous_label = previous
    following_boundary, following_label = following
    previous_is_background = previous_label is None
    following_is_background = following_label is None

    if previous_is_background:
        if following_is_background:
            return _viterbi_biases["transition_bias_background_stay"]
        if following_boundary in {"B", "S"}:
            return _viterbi_biases["transition_bias_background_to_start"]
        return None

    previous_is_bio = boundaries.get(previous_label) == {"B", "I"}
    if previous_is_bio:
        if following_label == previous_label and following_boundary == "I":
            return _viterbi_biases["transition_bias_inside_to_continue"]
        if following_is_background:
            return _viterbi_biases["transition_bias_end_to_background"]
        if following_boundary in {"B", "S"}:
            return _viterbi_biases["transition_bias_end_to_start"]
        return None

    if previous_boundary in {"B", "I"}:
        if following_label != previous_label:
            return None
        if following_boundary == "I":
            return _viterbi_biases["transition_bias_inside_to_continue"]
        if following_boundary == "E":
            return _viterbi_biases["transition_bias_inside_to_end"]
        return None

    if previous_boundary in {"E", "S"}:
        if following_is_background:
            return _viterbi_biases["transition_bias_end_to_background"]
        if following_boundary in {"B", "S"}:
            return _viterbi_biases["transition_bias_end_to_start"]
    return None


def _viterbi_decode(log_probabilities: Any) -> list[int]:
    """Return the highest-scoring structurally valid BIO/BIOES label path."""

    import torch

    if log_probabilities.ndim != 2:
        raise ValueError("OpenAI Privacy Filter logits must have shape [tokens, labels]")
    sequence_length, class_count = log_probabilities.shape
    if sequence_length == 0:
        return []

    states = [_label_state(_id2label.get(index, "O")) for index in range(class_count)]
    boundaries: dict[str, set[str]] = {}
    for boundary, native_label in states:
        if boundary is not None and native_label is not None:
            boundaries.setdefault(native_label, set()).add(boundary)

    negative_infinity = -1e9
    start_scores = torch.full_like(log_probabilities[0], negative_infinity)
    end_scores = torch.full_like(log_probabilities[0], negative_infinity)
    transition_scores = torch.full(
        (class_count, class_count),
        negative_infinity,
        device=log_probabilities.device,
        dtype=log_probabilities.dtype,
    )

    for index, (boundary, native_label) in enumerate(states):
        is_background = native_label is None
        is_bio = native_label is not None and boundaries.get(native_label) == {"B", "I"}
        if is_background or boundary in {"B", "S"}:
            start_scores[index] = 0.0
        if is_background or boundary in {"E", "S"} or (is_bio and boundary in {"B", "I"}):
            end_scores[index] = 0.0
        for following_index, following in enumerate(states):
            bias = _transition_bias((boundary, native_label), following, boundaries)
            if bias is not None:
                transition_scores[index, following_index] = bias

    scores = log_probabilities[0] + start_scores
    backpointers = []
    for token_index in range(1, sequence_length):
        paths = scores.unsqueeze(1) + transition_scores
        best_scores, best_previous = paths.max(dim=0)
        scores = best_scores + log_probabilities[token_index]
        backpointers.append(best_previous)

    scores = scores + end_scores
    last_label = int(scores.argmax())
    path = [last_label]
    for previous in reversed(backpointers):
        last_label = int(previous[last_label])
        path.append(last_label)
    path.reverse()
    return path


def _predict_windows(text: str) -> list[list[_TokenPrediction]]:
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

    predictions: list[list[_TokenPrediction]] = []
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

        window_predictions: list[_TokenPrediction] = []
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
            if not 0 <= start < end <= len(text):
                continue
            active_tokens.append((token_index, start, end))

        if not active_tokens:
            predictions.append([])
            continue

        log_probabilities = logits[0].float().log_softmax(dim=-1)
        active_log_probabilities = log_probabilities[
            [token_index for token_index, _, _ in active_tokens]
        ]
        label_ids = _viterbi_decode(active_log_probabilities)
        probabilities = active_log_probabilities.exp()
        for prediction_index, ((_, start, end), label_id) in enumerate(
            zip(active_tokens, label_ids, strict=True)
        ):
            label = _id2label.get(label_id)
            score = _finite_score(probabilities[prediction_index, label_id])
            if label is None or score is None:
                continue
            window_predictions.append(_TokenPrediction(label, start, end, score))
        predictions.append(window_predictions)
    return predictions


def _reconstruct_window(
    predictions: Sequence[_TokenPrediction],
    text_length: int,
) -> list[_Candidate]:
    spans: list[_Candidate] = []
    current_label: str | None = None
    current_type: str | None = None
    start = 0
    end = 0
    scores: list[float] = []

    def close_current() -> None:
        nonlocal current_label, current_type, end, scores, start
        if (
            current_label is not None
            and current_type is not None
            and scores
            and 0 <= start < end <= text_length
        ):
            spans.append(
                _Candidate(
                    current_label,
                    current_type,
                    start,
                    end,
                    sum(scores) / len(scores),
                )
            )
        current_label = None
        current_type = None
        start = 0
        end = 0
        scores = []

    def start_current(native_label: str, entity_type: str, token: _TokenPrediction) -> None:
        nonlocal current_label, current_type, end, scores, start
        current_label = native_label
        current_type = entity_type
        start = token.start
        end = token.end
        scores = [token.score]

    for token in predictions:
        match = _BOUNDARY_RE.fullmatch(token.label)
        if match is None:
            close_current()
            continue
        boundary, native_label = match.groups()
        entity_type = _LABEL_TO_TYPE.get(native_label)
        if entity_type is None:
            # Compatible fine-tunes may add categories that PasteGuard does not
            # expose. Treat them as background rather than inventing a type.
            close_current()
            continue

        if boundary == "S":
            close_current()
            start_current(native_label, entity_type, token)
            close_current()
        elif boundary == "B":
            close_current()
            start_current(native_label, entity_type, token)
        elif boundary == "I":
            if current_label != native_label:
                close_current()
                start_current(native_label, entity_type, token)
            else:
                end = max(end, token.end)
                scores.append(token.score)
        elif boundary == "E":
            if current_label != native_label:
                close_current()
                start_current(native_label, entity_type, token)
            else:
                end = max(end, token.end)
                scores.append(token.score)
            close_current()

    close_current()
    return spans


def _consolidate_candidates(candidates: Sequence[_Candidate]) -> list[_Candidate]:
    # Exact duplicates occur in overlapping tokenizer windows. Keep the
    # strongest instance, then join overlapping or touching fragments of the
    # same model category before whitespace trimming and thresholding.
    best: dict[tuple[str, int, int], _Candidate] = {}
    for candidate in candidates:
        key = (candidate.native_label, candidate.start, candidate.end)
        if key not in best or candidate.score > best[key].score:
            best[key] = candidate

    consolidated: list[_Candidate] = []
    for candidate in sorted(
        best.values(),
        key=lambda item: (item.native_label, item.start, -item.end, -item.score),
    ):
        previous = consolidated[-1] if consolidated else None
        if (
            previous is not None
            and previous.native_label == candidate.native_label
            and candidate.start <= previous.end
        ):
            extends_span = candidate.end > previous.end
            consolidated[-1] = _Candidate(
                previous.native_label,
                previous.entity_type,
                previous.start,
                max(previous.end, candidate.end),
                max(previous.score, candidate.score) if extends_span else previous.score,
            )
        else:
            consolidated.append(candidate)

    consolidated.sort(key=lambda item: (item.start, item.end, item.entity_type))
    return consolidated


def detect_openai_privacy_filter(text: str, score_threshold: float = 0.0) -> list[Span]:
    if not text:
        return []
    if _model is None or _tokenizer is None:
        raise RuntimeError(
            "OpenAI Privacy Filter model not loaded; load_semantic_backend() selects and loads it"
        )

    with _infer_lock:
        windows = _predict_windows(text)

    candidates = _consolidate_candidates(
        [
            candidate
            for predictions in windows
            for candidate in _reconstruct_window(predictions, len(text))
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
            spans.append(
                Span(
                    candidate.entity_type,
                    start,
                    end,
                    candidate.score,
                )
            )
    return spans
