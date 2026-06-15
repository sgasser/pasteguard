"""Merge the deterministic and fuzzy layers into the final entity list.

Rules:
  * deterministic spans (score 1.0) always outrank fuzzy spans on overlap;
  * among fuzzy spans, the longer one wins, then the higher score;
  * fuzzy spans below `score_threshold` are dropped (deterministic = 1.0 always
    passes);
  * the result is filtered to the requested `entities` and sorted by start.
"""

from __future__ import annotations

from collections.abc import Iterable

from .entities import Span, overlaps


def merge(
    deterministic: list[Span],
    fuzzy: list[Span],
    entities: Iterable[str] | None = None,
    score_threshold: float = 0.0,
) -> list[Span]:
    # Restrict to the requested types up front. Filtering only at the end would
    # let a longer non-requested span win an overlap and suppress a requested
    # one, then be dropped itself — silently losing the requested entity.
    if entities:
        allow = set(entities)
        deterministic = [s for s in deterministic if s.entity_type in allow]
        fuzzy = [s for s in fuzzy if s.entity_type in allow]

    # Deterministic spans are pre-resolved (non-overlapping) and take precedence.
    accepted: list[Span] = [s for s in deterministic if s.score >= score_threshold]

    # Longer fuzzy spans first, then higher score, for stable overlap resolution.
    for span in sorted(fuzzy, key=lambda s: (-s.length, -s.score)):
        if span.score < score_threshold:
            continue
        if any(overlaps(span, a) for a in accepted):
            continue
        accepted.append(span)

    accepted.sort(key=lambda s: (s.start, s.end))
    return accepted
