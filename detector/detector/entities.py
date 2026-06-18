"""Entity types and the internal span representation.

Entity type strings are the labels PasteGuard expects on the /analyze response
(see src/pii/detect.ts).
"""

from __future__ import annotations

from dataclasses import dataclass

# Entity type strings returned on the /analyze response. The Presidio drop-in
# set plus VAT_CODE (EU VAT numbers, checksum-validated). Other structured types
# (org/address/fiscal/BIC/crypto) are not currently emitted.
PERSON = "PERSON"
LOCATION = "LOCATION"
EMAIL_ADDRESS = "EMAIL_ADDRESS"
PHONE_NUMBER = "PHONE_NUMBER"
CREDIT_CARD = "CREDIT_CARD"
IBAN_CODE = "IBAN_CODE"
IP_ADDRESS = "IP_ADDRESS"
VAT_CODE = "VAT_CODE"


@dataclass(frozen=True)
class Span:
    """A detected entity span. `start`/`end` are character offsets into the
    submitted text; `score` is in [0, 1] (deterministic matches are 1.0)."""

    entity_type: str
    start: int
    end: int
    score: float

    @property
    def length(self) -> int:
        return self.end - self.start


def overlaps(a: Span, b: Span) -> bool:
    """Half-open span overlap (touching spans, end == start, do not overlap)."""
    return a.start < b.end and b.start < a.end
