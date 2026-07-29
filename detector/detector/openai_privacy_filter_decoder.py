"""BIO/BIOES decoding and span reconstruction for OpenAI Privacy Filter.

Transformers' simple aggregation only understands BIO labels. The Privacy
Filter checkpoint also uses E/S boundaries, so it needs its own constrained
path decoder.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .openai_privacy_filter_labels import BOUNDARY_RE, LABEL_TO_TYPE, label_state

VITERBI_BIAS_KEYS = (
    "transition_bias_background_stay",
    "transition_bias_background_to_start",
    "transition_bias_inside_to_continue",
    "transition_bias_inside_to_end",
    "transition_bias_end_to_background",
    "transition_bias_end_to_start",
)


@dataclass(frozen=True)
class TokenPrediction:
    label: str
    start: int
    end: int
    score: float


@dataclass(frozen=True)
class Candidate:
    entity_type: str
    start: int
    end: int
    score: float


def default_viterbi_biases() -> dict[str, float]:
    return dict.fromkeys(VITERBI_BIAS_KEYS, 0.0)


def _transition_bias(
    previous: tuple[str | None, str | None],
    following: tuple[str | None, str | None],
    boundaries: Mapping[str, set[str]],
    biases: Mapping[str, float],
) -> float | None:
    previous_boundary, previous_label = previous
    following_boundary, following_label = following
    previous_is_background = previous_label is None
    following_is_background = following_label is None

    if previous_is_background:
        if following_is_background:
            return biases["transition_bias_background_stay"]
        if following_boundary in {"B", "S"}:
            return biases["transition_bias_background_to_start"]
        return None

    previous_is_bio = boundaries.get(previous_label) == {"B", "I"}
    if previous_is_bio:
        if following_label == previous_label and following_boundary == "I":
            return biases["transition_bias_inside_to_continue"]
        if following_is_background:
            return biases["transition_bias_end_to_background"]
        if following_boundary in {"B", "S"}:
            return biases["transition_bias_end_to_start"]
        return None

    if previous_boundary in {"B", "I"}:
        if following_label != previous_label:
            return None
        if following_boundary == "I":
            return biases["transition_bias_inside_to_continue"]
        if following_boundary == "E":
            return biases["transition_bias_inside_to_end"]
        return None

    if previous_boundary in {"E", "S"}:
        if following_is_background:
            return biases["transition_bias_end_to_background"]
        if following_boundary in {"B", "S"}:
            return biases["transition_bias_end_to_start"]
    return None


def viterbi_decode(
    log_probabilities: Any,
    id2label: Mapping[int, str],
    biases: Mapping[str, float],
) -> list[int]:
    """Return the highest-scoring structurally valid BIO/BIOES label path."""

    import torch

    if log_probabilities.ndim != 2:
        raise ValueError("OpenAI Privacy Filter logits must have shape [tokens, labels]")
    sequence_length, class_count = log_probabilities.shape
    if sequence_length == 0:
        return []

    states = [label_state(id2label.get(index, "O")) for index in range(class_count)]
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

    for index, state in enumerate(states):
        boundary, native_label = state
        is_background = native_label is None
        is_bio = native_label is not None and boundaries.get(native_label) == {"B", "I"}
        if is_background or boundary in {"B", "S"}:
            start_scores[index] = 0.0
        if is_background or boundary in {"E", "S"} or (is_bio and boundary in {"B", "I"}):
            end_scores[index] = 0.0
        for following_index, following in enumerate(states):
            bias = _transition_bias(state, following, boundaries, biases)
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


def reconstruct_spans(
    predictions: Sequence[TokenPrediction],
    text_length: int,
) -> list[Candidate]:
    spans: list[Candidate] = []
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
                Candidate(
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

    def start_current(native_label: str, entity_type: str, token: TokenPrediction) -> None:
        nonlocal current_label, current_type, end, scores, start
        current_label = native_label
        current_type = entity_type
        start = token.start
        end = token.end
        scores = [token.score]

    for token in predictions:
        match = BOUNDARY_RE.fullmatch(token.label)
        if match is None:
            close_current()
            continue
        boundary, native_label = match.groups()
        entity_type = LABEL_TO_TYPE.get(native_label)
        if entity_type is None:
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
