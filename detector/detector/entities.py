"""Entity types and the internal span representation.

Entity type strings are the labels PasteGuard expects on the /analyze response
(see src/pii/detect.ts).
"""

from __future__ import annotations

from dataclasses import dataclass

# Entity type strings returned on the /analyze response.
PERSON = "PERSON"
LOCATION = "LOCATION"
ORGANIZATION = "ORGANIZATION"
ADDRESS = "ADDRESS"
EMAIL_ADDRESS = "EMAIL_ADDRESS"
PHONE_NUMBER = "PHONE_NUMBER"
CREDIT_CARD = "CREDIT_CARD"
IBAN_CODE = "IBAN_CODE"
IP_ADDRESS = "IP_ADDRESS"
IT_FISCAL_CODE = "IT_FISCAL_CODE"
# Single EU VAT label (validated per-country via stdnum.eu.vat). Country-specific
# VAT splits (and IDs like the German Steuernummer) are deferred to per-deployment
# tuning rather than baked into the open layer.
VAT_CODE = "VAT_CODE"
BIC_CODE = "BIC_CODE"
CRYPTO = "CRYPTO"


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
