"""Fuzzy layer: multilingual GLiNER NER for person, location, organization, address.

Each label has its own confidence floor (PER_LABEL_FLOOR). The request
`score_threshold` only raises the tunable labels (person, location).
"""

from __future__ import annotations

import os
import re
import threading
from typing import Any

from .entities import ADDRESS, LOCATION, ORGANIZATION, PERSON, Span

# Organizations are kept only if they carry a legal-form designator: GLiNER
# scores brand-like noun phrases as high as real companies, so a bare brand
# (e.g. "Microsoft") is intentionally not matched. DE/IT/EN/NL/ES forms.
_ORG_DESIGNATOR = re.compile(
    r"\b(GmbH|mbH|UG|AG|KG|OHG|GbR|eG|e\.?\s?V|S\.?r\.?l|S\.?p\.?A|S\.?n\.?c|"
    r"S\.?a\.?s|Inc|Corp|Corporation|Ltd|LLC|PLC|B\.?V|N\.?V|S\.?A|S\.?L|"
    r"Studio|Sparkasse|Bank|Banca|Cassa|Holding|Group|Associati|Partner)\b",
    re.IGNORECASE,
)

DEFAULT_MODEL = "urchade/gliner_multi_pii-v1"


def _floor(label: str, default: float) -> float:
    return float(os.environ.get(f"DETECTOR_FLOOR_{label.upper()}", default))


# Per-label confidence floors (empirically calibrated on DE/IT data; overridable
# via env, e.g. DETECTOR_FLOOR_ADDRESS=0.6).
PER_LABEL_FLOOR = {
    "person": _floor("person", 0.70),
    "location": _floor("location", 0.50),
    "organization": _floor("organization", 0.80),
    "address": _floor("address", 0.55),
}
# Labels the request `score_threshold` may raise (high-volume, deployment-tunable).
_TUNABLE = {"person", "location"}

# Common words GLiNER mis-tags as entities, matched case-insensitively on the
# exact span text. Extend per deployment. Role words (client/customer/principal
# across DE/IT/FR/ES/EN/NL/PT, with and without article) are high-frequency
# PERSON false positives in business documents and are never names themselves.
_STOPWORDS = {
    "ich",
    "du",
    "er",
    "sie",
    "wir",
    "ihr",
    "sede",
    "sede legale",
    "lieferung",
    "anschrift",
    "indirizzo",
    "rechnung",
    "studio",
    "betreff",
    "gegenstand",
    "oggetto",
    # role words (DE)
    "mandant",
    "mandantin",
    "der mandant",
    "die mandantin",
    "kunde",
    "kundin",
    "der kunde",
    "die kundin",
    "klient",
    "klientin",
    "der klient",
    "die klientin",
    # role words (IT)
    "cliente",
    "il cliente",
    "la cliente",
    "mandante",
    # role words (FR)
    "client",
    "le client",
    # role words (ES)
    "el cliente",
    # role words (EN)
    "customer",
    "the customer",
    "the client",
    # role words (NL)
    "klant",
    "de klant",
    # role words (PT)
    "o cliente",
    "a cliente",
}

_LABELS = list(PER_LABEL_FLOOR)
_LABEL_TO_TYPE = {
    "person": PERSON,
    "location": LOCATION,
    "organization": ORGANIZATION,
    "address": ADDRESS,
}
# Capture candidates below every floor so per-label filtering has them.
_PREDICT_FLOOR = min(PER_LABEL_FLOOR.values()) - 0.1

# GLiNER truncates input past its word-token limit (~384), so long text would
# drop PII past the cut. Split into overlapping windows; the splitter mirrors
# GLiNER's WhitespaceTokenSplitter so window sizes match.
_TOKEN_RE = re.compile(r"\w+(?:[-_]\w+)*|\S")
_MAX_TOKENS = int(os.environ.get("DETECTOR_MAX_TOKENS", "384"))
_WINDOW = max(64, _MAX_TOKENS - 64)  # headroom under the hard limit
_OVERLAP = 64  # >= longest expected entity, so boundary-straddling spans survive


def _windows(text: str):
    """Yield (char_offset, subtext) windows. One window for short text; for long
    text, overlapping windows of <= _WINDOW word-tokens."""
    toks = [(m.start(), m.end()) for m in _TOKEN_RE.finditer(text)]
    if len(toks) <= _MAX_TOKENS:
        yield 0, text
        return
    step = max(1, _WINDOW - _OVERLAP)
    i = 0
    while i < len(toks):
        window = toks[i : i + _WINDOW]
        cstart, cend = window[0][0], window[-1][1]
        yield cstart, text[cstart:cend]
        if i + _WINDOW >= len(toks):
            break
        i += step


# GLiNER ships no type stubs, so the loaded model is untyped (Any).
_model: Any = None
_lock = threading.Lock()
# Torch inference is not guaranteed thread-safe; serialize concurrent /analyze calls.
_infer_lock = threading.Lock()


def _model_name() -> str:
    return (
        os.environ.get("DETECTOR_MODEL_PATH") or os.environ.get("DETECTOR_MODEL") or DEFAULT_MODEL
    )


def load_model() -> None:
    """Load the model once. Safe to call at startup or lazily."""
    global _model
    if _model is not None:
        return
    with _lock:
        if _model is not None:
            return
        from gliner import GLiNER

        _model = GLiNER.from_pretrained(_model_name())


def detect_gliner(text: str, score_threshold: float = 0.0) -> list[Span]:
    if not text:
        return []
    load_model()
    n = len(text)
    # Run each window, shift spans back to absolute offsets, dedupe overlaps
    # (same span+label) keeping the max score.
    best: dict[tuple[int, int, str], float] = {}
    with _infer_lock:
        for offset, sub in _windows(text):
            for ent in _model.predict_entities(sub, _LABELS, threshold=max(0.0, _PREDICT_FLOOR)):
                key = (offset + int(ent["start"]), offset + int(ent["end"]), ent["label"])
                score = float(ent["score"])
                if score > best.get(key, -1.0):
                    best[key] = score

    out: list[Span] = []
    for (start, end, label), score in best.items():
        etype = _LABEL_TO_TYPE.get(label)
        if etype is None:
            continue
        floor = PER_LABEL_FLOOR[label]
        if label in _TUNABLE:
            floor = max(floor, score_threshold)
        if score < floor:
            continue
        # Drop out-of-bounds spans from tokenization bugs (would mask wrong text).
        if not 0 <= start < end <= n:
            continue
        span_text = text[start:end]
        if span_text.strip().lower() in _STOPWORDS:
            continue
        if label == "organization" and not _ORG_DESIGNATOR.search(span_text):
            continue
        out.append(Span(etype, start, end, score))
    return out
