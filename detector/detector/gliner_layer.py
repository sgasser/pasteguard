"""Fuzzy layer: multilingual GLiNER NER for person, location, organization, address.

Structured identifiers are owned by the deterministic layer. A single global
threshold cannot serve PERSON (needs high precision) and ADDRESS (faint but
important) at once, so each label has its own calibrated floor. The request
`score_threshold` can *raise* the tunable labels (person, location); the others
keep their floor so the global knob does not silently drop them.
"""

from __future__ import annotations

import os
import re
import threading

from .entities import ADDRESS, LOCATION, ORGANIZATION, PERSON, Span

# A legal-form designator that real company names carry in formal documents.
# GLiNER scores brand-like common-noun phrases ("Il caffè italiano") as high as
# real orgs, so requiring a designator is the only reliable separator. This is
# precision-first: a bare brand name without a legal form (e.g. "Microsoft") is
# not matched as an organization. Tune per deployment.
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

# Seed stoplist: common DE/IT/EN words GLiNER mis-tags as an entity (matched on
# the exact span text, case-insensitive). A precision floor for the highest-
# frequency false positives; extend per deployment. Not a substitute for a
# tuned model, but it removes obvious noise like "Ich" -> PERSON or
# "Lieferung" -> ORGANIZATION.
_STOPWORDS = {
    "ich", "du", "er", "sie", "wir", "ihr",
    "der mandant", "die mandantin", "mandant", "mandantin", "kunde", "kundin",
    "sede", "sede legale", "lieferung", "anschrift", "indirizzo", "rechnung",
    "studio", "betreff", "gegenstand", "oggetto",
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

_model = None
_lock = threading.Lock()
# PasteGuard issues concurrent /analyze calls (one per text span). Torch
# inference is not guaranteed thread-safe, so serialize it. For a fail-closed
# privacy tool, correct-but-serial beats fast-but-racy.
_infer_lock = threading.Lock()


def _model_name() -> str:
    return os.environ.get("DETECTOR_MODEL_PATH") or os.environ.get("DETECTOR_MODEL") or DEFAULT_MODEL


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
    with _infer_lock:
        raw = _model.predict_entities(text, _LABELS, threshold=max(0.0, _PREDICT_FLOOR))
    n = len(text)
    out: list[Span] = []
    for ent in raw:
        label = ent["label"]
        etype = _LABEL_TO_TYPE.get(label)
        if etype is None:
            continue
        floor = PER_LABEL_FLOOR[label]
        if label in _TUNABLE:
            floor = max(floor, score_threshold)
        score = float(ent["score"])
        if score < floor:
            continue
        if ent["text"].strip().lower() in _STOPWORDS:
            continue
        # Organizations must carry a legal-form designator (precision-first).
        if label == "organization" and not _ORG_DESIGNATOR.search(ent["text"]):
            continue
        start, end = int(ent["start"]), int(ent["end"])
        # Guard against out-of-bounds offsets from model/tokenization bugs: a bad
        # span would make PasteGuard mask the wrong text. Drop it (fail safe).
        if not 0 <= start < end <= n:
            continue
        out.append(Span(etype, start, end, score))
    return out
