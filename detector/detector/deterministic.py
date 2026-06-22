"""Deterministic layer: regex candidates gated by checksum/format validation.

Owns the structured identifiers. Every match scores 1.0 because it is
checksum-validated, not guessed. Detectors run in priority order and a later
detector never claims a span that overlaps one already accepted, so an IBAN is
not also reported as a credit card, etc.
"""

from __future__ import annotations

import ipaddress
import re

import phonenumbers
from stdnum import iban as _iban_lib
from stdnum import luhn as _luhn
from stdnum.eu import vat as _eu_vat

from .entities import (
    CREDIT_CARD,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    PHONE_NUMBER,
    VAT_CODE,
    Span,
    overlaps,
)

# Default phonenumbers region per request language, so national-format numbers
# (not only +international) are matched.
LANG_TO_REGION = {
    "de": "DE",
    "it": "IT",
    "fr": "FR",
    "es": "ES",
    "en": "US",
    "nl": "NL",
    "pt": "PT",
    "pl": "PL",
    "ro": "RO",
}
EXTRA_LANGUAGE_REGIONS = {
    # English benchmark and real traffic may contain either US or UK national
    # formats. The primary region stays US; GB is an additional pass.
    "en": ["GB"],
    # Conservative CLDR-backed language regions where national phone formats
    # are common in same-language text.
    "de": ["AT", "CH"],
    "fr": ["BE", "CH", "LU"],
    "nl": ["BE"],
    "pt": ["BR"],
    "ro": ["MD"],
}

# `\w` is Unicode-aware so accented names (müller@, andré.) match in full;
# structure rejects leading/trailing/consecutive dots.
_EMAIL_RE = re.compile(
    r"(?<![\w.%+\-@])"
    r"[\w%+\-]+(?:\.[\w%+\-]+)*"
    r"@(?:[\w\-]+\.)+[^\W\d_]{2,}"
    r"(?![\w\-])"
)
# A trailing "." is allowed (sentence punctuation); it is only rejected when it
# starts another octet (\.\d), which would make the token a longer dotted-numeric
# string rather than an IPv4 address.
_IPV4_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w])(?!\.\d)")
# IBAN: country + check digits then space-grouped alnum. Case-insensitive, so a
# lowercase IBAN is also matched; since lowercase can't be told from prose by
# case, _iban() validates and trims trailing tokens with stdnum to stop the bleed.
_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[ ]?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])"
)
_CC_RE = re.compile(r"(?<![\d])(?:\d[ \-]?){13,19}(?<![\s\-])(?!\d)")
# IPv6: generous candidate (hex/colon/dot) gated by Python's ipaddress parser.
_IPV6_RE = re.compile(r"(?<![\w:.])[0-9A-Fa-f.:]{2,45}(?![\w:.])")
# EU VAT country prefixes; stdnum.eu.vat validates the per-country checksum.
_VAT_CC = "AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|EL|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|EU"
# Overlapping (lookahead) candidates so a word prefix like "it" can't hide a real VAT.
_VAT_RE = re.compile(
    r"(?<![A-Za-z0-9])(?=(?P<code>" + _VAT_CC + r")[ ]?(?P<body>[0-9A-Za-z]{8,12})(?![A-Za-z0-9]))",
    re.IGNORECASE,
)


def _email(text: str) -> list[Span]:
    return [Span(EMAIL_ADDRESS, m.start(), m.end(), 1.0) for m in _EMAIL_RE.finditer(text)]


def _ipv4(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _IPV4_RE.finditer(text):
        if all(0 <= int(o) <= 255 for o in m.group().split(".")):
            out.append(Span(IP_ADDRESS, m.start(), m.end(), 1.0))
    return out


def _ipv6(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _IPV6_RE.finditer(text):
        s = m.group()
        end = m.end()
        # "." is in the candidate class, so a sentence-ending period is captured
        # too; trim trailing dots before validating so an IPv6 that ends a
        # sentence still parses (mirrors the IPv4 trailing-period handling).
        while s.endswith("."):
            s = s[:-1]
            end -= 1
        if ":" not in s:
            continue
        try:
            ipaddress.IPv6Address(s)
        except ValueError:
            continue
        out.append(Span(IP_ADDRESS, m.start(), end, 1.0))
    return out


def _iban(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _IBAN_RE.finditer(text):
        # The match may have run past the IBAN into following prose (a lowercase
        # IBAN is indistinguishable from prose by case). Trim trailing space-
        # separated tokens until the candidate validates; tokens are single-space
        # joined, so the trimmed candidate is an exact prefix of the match.
        tokens = m.group().split(" ")
        while tokens:
            candidate = " ".join(tokens)
            if _iban_lib.is_valid(candidate.replace(" ", "")):
                out.append(Span(IBAN_CODE, m.start(), m.start() + len(candidate), 1.0))
                break
            tokens.pop()
    return out


def _vat(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _VAT_RE.finditer(text):
        if _eu_vat.is_valid(m.group("code") + m.group("body")):
            out.append(Span(VAT_CODE, m.start("code"), m.end("body"), 1.0))
    return out


def _credit_card(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _CC_RE.finditer(text):
        digits = re.sub(r"[ \-]", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn.is_valid(digits):
            out.append(Span(CREDIT_CARD, m.start(), m.end(), 1.0))
    return out


def _phone(text: str, language: str) -> list[Span]:
    language_key = (language or "").lower()
    region = LANG_TO_REGION.get(language_key)
    regions = [region] if region else []
    regions.extend(EXTRA_LANGUAGE_REGIONS.get(language_key, []))
    out: list[Span] = []
    # VALID leniency: only well-formed, assignable numbers. POSSIBLE would flag
    # long invoice/ID digit runs as phones.
    for candidate_region in regions or [None]:
        for match in phonenumbers.PhoneNumberMatcher(
            text, candidate_region, leniency=phonenumbers.Leniency.VALID
        ):
            span = Span(PHONE_NUMBER, match.start, match.end, 1.0)
            if not any(s.start == span.start and s.end == span.end for s in out):
                out.append(span)
    return out


# Priority order: most specific first. A later detector's span is dropped if it
# overlaps an already-accepted one.
def detect_deterministic(text: str, language: str = "") -> list[Span]:
    if not text:
        return []

    ordered: list[Span] = []
    ordered += _email(text)
    # IPv6 before IPv4 so an IPv4-mapped/embedded IPv6 (e.g. ::ffff:192.168.0.1)
    # is claimed in full, not truncated to its IPv4 tail by overlap resolution.
    ordered += _ipv6(text)
    ordered += _ipv4(text)
    ordered += _iban(text)
    ordered += _vat(text)
    ordered += _credit_card(text)
    ordered += _phone(text, language)

    accepted: list[Span] = []
    for span in ordered:
        if any(overlaps(span, a) for a in accepted):
            continue
        accepted.append(span)
    return accepted
