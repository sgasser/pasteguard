from __future__ import annotations

from bisect import bisect_left
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel

from .deterministic import detect_deterministic
from .gliner_layer import detect_gliner, load_model
from .merge import merge


def _utf16_mapper(text: str):
    """Return a function mapping a Python codepoint offset to a UTF-16 code-unit
    offset. PasteGuard runs in JS and slices the returned offsets as UTF-16
    (`text.slice`), so an astral-plane character (emoji, rare CJK > U+FFFF)
    before a span would otherwise misalign the mask. Identity for all-BMP text.
    """
    astral = [i for i, c in enumerate(text) if ord(c) > 0xFFFF]
    if not astral:
        return lambda pos: pos
    return lambda pos: pos + bisect_left(astral, pos)


class AnalyzeRequest(BaseModel):
    text: str
    phone_regions: list[str] | None = None
    entities: list[str] | None = None
    score_threshold: float = 0.0


class Entity(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the model before serving so /health == ready (PasteGuard polls it).
    load_model()
    yield


app = FastAPI(title="PasteGuard Detector", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze", response_model=list[Entity])
def analyze(req: AnalyzeRequest) -> list[Entity]:
    deterministic = detect_deterministic(req.text, req.phone_regions)
    fuzzy = detect_gliner(req.text, req.score_threshold)
    spans = merge(deterministic, fuzzy, req.entities, 0.0)
    to_u16 = _utf16_mapper(req.text)
    return [
        Entity(
            entity_type=s.entity_type,
            start=to_u16(s.start),
            end=to_u16(s.end),
            score=round(s.score, 4),
        )
        for s in spans
    ]
