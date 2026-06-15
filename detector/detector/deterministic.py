"""Deterministic layer: regex candidates gated by checksum/format validation.

Owns the structured identifiers. Every match scores 1.0 because it is
checksum-validated, not guessed. Detectors run in priority order and a later
detector never claims a span that overlaps one already accepted, so a German
Steuernummer is not also reported as a credit card, etc.
"""

from __future__ import annotations

import re

import phonenumbers
from codicefiscale import codicefiscale as _cf
from stdnum import iban as _iban_lib
from stdnum import luhn as _luhn
from stdnum.de import stnr as _de_stnr
from stdnum.de import vat as _de_vat
from stdnum.it import iva as _it_iva

from .entities import (
    CREDIT_CARD,
    DE_TAX_CODE,
    DE_VAT_CODE,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    IT_FISCAL_CODE,
    IT_VAT_CODE,
    PHONE_NUMBER,
    Span,
)

# Map a request language to a phonenumbers default region so national-format
# numbers (not just +international) are found. Detection itself stays
# language-agnostic; this only widens phone coverage.
LANG_TO_REGION = {
    "de": "DE",
    "it": "IT",
    "fr": "FR",
    "es": "ES",
    "en": "US",
    "nl": "NL",
    "pt": "PT",
}

# Local and domain parts are dot-separated alnum (+ a few local-part symbols);
# this rejects leading/trailing/consecutive dots that the naive `[...]+` allowed.
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+\-])[A-Za-z0-9%+_\-]+(?:\.[A-Za-z0-9%+_\-]+)*"
    r"@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9\-])"
)
_IPV4_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
# IBAN: uppercase country+check digits then alnum groups with optional single
# spaces. Case-sensitive so it never bleeds into lowercase words after the IBAN.
_IBAN_RE = re.compile(r"(?<![A-Z0-9])[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){11,30}(?![A-Z0-9])")
_CF_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{6}[0-9]{2}[A-Za-z][0-9]{2}[A-Za-z][0-9]{3}[A-Za-z](?![A-Za-z0-9])"
)
_DE_VAT_RE = re.compile(r"(?<![A-Za-z0-9])DE[0-9]{9}(?![0-9])")
_PIVA_RE = re.compile(r"(?<![A-Za-z0-9])(?:IT)?[0-9]{11}(?![0-9])")
_DE_STNR_RE = re.compile(r"(?<!\d)\d{10,13}(?!\d)")
# A German Steuernummer has no strong checksum (stdnum accepts almost any
# 10-13 digit number), so a bare digit run is too ambiguous to flag. Require a
# Steuernummer label within the preceding window to disambiguate from invoice
# numbers, IDs, etc. (USt-IdNr and the other IDs carry their own anchors.)
_STNR_CONTEXT = re.compile(r"steuer\s*-?\s*(nummer|nr)|st\.?\s*-?\s*nr", re.IGNORECASE)
_STNR_CONTEXT_WINDOW = 40
_CC_RE = re.compile(r"(?<![\d])(?:\d[ \-]?){13,19}(?<![\s\-])(?!\d)")


def _email(text: str) -> list[Span]:
    return [Span(EMAIL_ADDRESS, m.start(), m.end(), 1.0) for m in _EMAIL_RE.finditer(text)]


def _ipv4(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _IPV4_RE.finditer(text):
        if all(0 <= int(o) <= 255 for o in m.group().split(".")):
            out.append(Span(IP_ADDRESS, m.start(), m.end(), 1.0))
    return out


def _iban(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _IBAN_RE.finditer(text):
        if _iban_lib.is_valid(m.group().replace(" ", "")):
            out.append(Span(IBAN_CODE, m.start(), m.end(), 1.0))
    return out


def _codice_fiscale(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _CF_RE.finditer(text):
        if _cf.is_valid(m.group().upper()):
            out.append(Span(IT_FISCAL_CODE, m.start(), m.end(), 1.0))
    return out


def _de_vat_id(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _DE_VAT_RE.finditer(text):
        if _de_vat.is_valid(m.group()):
            out.append(Span(DE_VAT_CODE, m.start(), m.end(), 1.0))
    return out


def _partita_iva(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _PIVA_RE.finditer(text):
        digits = m.group()[2:] if m.group().startswith("IT") else m.group()
        if _it_iva.is_valid(digits):
            out.append(Span(IT_VAT_CODE, m.start(), m.end(), 1.0))
    return out


def _steuernummer(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _DE_STNR_RE.finditer(text):
        prefix = text[max(0, m.start() - _STNR_CONTEXT_WINDOW) : m.start()]
        if _STNR_CONTEXT.search(prefix) and _de_stnr.is_valid(m.group()):
            out.append(Span(DE_TAX_CODE, m.start(), m.end(), 1.0))
    return out


def _credit_card(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _CC_RE.finditer(text):
        digits = re.sub(r"[ \-]", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn.is_valid(digits):
            out.append(Span(CREDIT_CARD, m.start(), m.end(), 1.0))
    return out


def _phone(text: str, language: str) -> list[Span]:
    region = LANG_TO_REGION.get((language or "").lower())
    out: list[Span] = []
    # VALID (not POSSIBLE): only well-formed, assignable numbers. POSSIBLE
    # would flag long invoice/ID digit runs as phones — the FP noise we exist
    # to avoid. Reserved fictional ranges (US 555) are intentionally not matched.
    for match in phonenumbers.PhoneNumberMatcher(
        text, region, leniency=phonenumbers.Leniency.VALID
    ):
        out.append(Span(PHONE_NUMBER, match.start, match.end, 1.0))
    return out


# Priority order: most specific first. A later detector's span is dropped if it
# overlaps an already-accepted one.
def detect_deterministic(text: str, language: str = "") -> list[Span]:
    if not text:
        return []

    ordered: list[Span] = []
    ordered += _email(text)
    ordered += _ipv4(text)
    ordered += _iban(text)
    ordered += _codice_fiscale(text)
    ordered += _de_vat_id(text)
    ordered += _partita_iva(text)
    ordered += _steuernummer(text)
    ordered += _credit_card(text)
    ordered += _phone(text, language)

    accepted: list[Span] = []
    for span in ordered:
        if any(span.start < a.end and a.start < span.end for a in accepted):
            continue
        accepted.append(span)
    return accepted
