"""Entity types and the internal span representation.

Entity type strings are Presidio-compatible so the detector is a drop-in for
the `presidio_url` PasteGuard already speaks (see src/pii/detect.ts).
"""

from __future__ import annotations

from dataclasses import dataclass

# Presidio-compatible entity type strings.
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
IT_VAT_CODE = "IT_VAT_CODE"
DE_TAX_CODE = "DE_TAX_CODE"
DE_VAT_CODE = "DE_VAT_CODE"

# Everything the detector can emit. The request's `entities` list selects from
# this; an empty/omitted list means "return all".
ALL_ENTITY_TYPES: tuple[str, ...] = (
    PERSON,
    LOCATION,
    ORGANIZATION,
    ADDRESS,
    EMAIL_ADDRESS,
    PHONE_NUMBER,
    CREDIT_CARD,
    IBAN_CODE,
    IP_ADDRESS,
    IT_FISCAL_CODE,
    IT_VAT_CODE,
    DE_TAX_CODE,
    DE_VAT_CODE,
)


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
