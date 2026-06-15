"""Deterministic layer: regex candidates gated by checksum/format validation.

Owns the structured identifiers. Every match scores 1.0 because it is
checksum-validated, not guessed. Detectors run in priority order and a later
detector never claims a span that overlaps one already accepted, so an IBAN is
not also reported as a VAT code or credit card, etc.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re

import phonenumbers
from codicefiscale import codicefiscale as _cf
from stdnum import bic as _bic_lib
from stdnum import iban as _iban_lib
from stdnum import luhn as _luhn
from stdnum.eu import vat as _eu_vat

from .entities import (
    BIC_CODE,
    CREDIT_CARD,
    CRYPTO,
    EMAIL_ADDRESS,
    IBAN_CODE,
    IP_ADDRESS,
    IT_FISCAL_CODE,
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
}

# `\w` is Unicode-aware so accented names (müller@, andré.) match in full;
# structure rejects leading/trailing/consecutive dots.
_EMAIL_RE = re.compile(
    r"(?<![\w.%+\-@])"
    r"[\w%+\-]+(?:\.[\w%+\-]+)*"
    r"@(?:[\w\-]+\.)+[^\W\d_]{2,}"
    r"(?![\w\-])"
)
_IPV4_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
# IBAN: country + check digits then space-grouped alnum. Case-insensitive, so a
# lowercase IBAN is also matched; since lowercase can't be told from prose by
# case, _iban() validates and trims trailing tokens with stdnum to stop the bleed.
_IBAN_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[ ]?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])"
)
_CF_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]{6}[0-9]{2}[A-Za-z][0-9]{2}[A-Za-z][0-9]{3}[A-Za-z](?![A-Za-z0-9])"
)
# EU VAT: two-letter country prefix + country-specific body, validated by
# stdnum's per-country checksum. The prefix is required — a bare number (e.g. a
# domestic Partita IVA without "IT") is too ambiguous to flag on one check digit.
_EU_VAT_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]{2}[A-Z0-9]{2,12}(?![A-Za-z0-9])")
_CC_RE = re.compile(r"(?<![\d])(?:\d[ \-]?){13,19}(?<![\s\-])(?!\d)")
# IPv6: generous candidate (hex/colon/dot) gated by Python's ipaddress parser.
_IPV6_RE = re.compile(r"(?<![\w:.])[0-9A-Fa-f.:]{2,45}(?![\w:.])")
# BIC/SWIFT: 6 letters + 2 alnum, optional 3-alnum branch; stdnum checks the
# embedded country code, so random uppercase tokens are rejected.
_BIC_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?![A-Za-z0-9])")
# Crypto: Ethereum (0x + 40 hex) and Bitcoin (base58 legacy / bech32).
_ETH_RE = re.compile(r"(?<!\w)0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
_BTC_RE = re.compile(r"(?<!\w)(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{11,71})(?!\w)")
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


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
        if ":" not in s:
            continue
        try:
            ipaddress.IPv6Address(s)
        except ValueError:
            continue
        out.append(Span(IP_ADDRESS, m.start(), m.end(), 1.0))
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


def _codice_fiscale(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _CF_RE.finditer(text):
        if _cf.is_valid(m.group().upper()):
            out.append(Span(IT_FISCAL_CODE, m.start(), m.end(), 1.0))
    return out


def _vat(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _EU_VAT_RE.finditer(text):
        if _eu_vat.is_valid(m.group()):
            out.append(Span(VAT_CODE, m.start(), m.end(), 1.0))
    return out


def _bic(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _BIC_RE.finditer(text):
        if _bic_lib.is_valid(m.group()):
            out.append(Span(BIC_CODE, m.start(), m.end(), 1.0))
    return out


def _b58check_valid(s: str) -> bool:
    num = 0
    for ch in s:
        i = _B58_ALPHABET.find(ch)
        if i < 0:
            return False
        num = num * 58 + i
    body = num.to_bytes((num.bit_length() + 7) // 8, "big")
    raw = b"\x00" * (len(s) - len(s.lstrip("1"))) + body
    if len(raw) < 5:
        return False
    return hashlib.sha256(hashlib.sha256(raw[:-4]).digest()).digest()[:4] == raw[-4:]


def _crypto(text: str) -> list[Span]:
    out: list[Span] = []
    for m in _ETH_RE.finditer(text):
        out.append(Span(CRYPTO, m.start(), m.end(), 1.0))
    for m in _BTC_RE.finditer(text):
        s = m.group()
        # bech32 (bc1…) accepted by format; legacy base58 must pass base58check.
        if s.startswith("bc1") or _b58check_valid(s):
            out.append(Span(CRYPTO, m.start(), m.end(), 1.0))
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
    # VALID leniency: only well-formed, assignable numbers. POSSIBLE would flag
    # long invoice/ID digit runs as phones.
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
    # IPv6 before IPv4 so an IPv4-mapped/embedded IPv6 (e.g. ::ffff:192.168.0.1)
    # is claimed in full, not truncated to its IPv4 tail by overlap resolution.
    ordered += _ipv6(text)
    ordered += _ipv4(text)
    ordered += _iban(text)
    ordered += _codice_fiscale(text)
    ordered += _vat(text)
    ordered += _bic(text)
    ordered += _crypto(text)
    ordered += _credit_card(text)
    ordered += _phone(text, language)

    accepted: list[Span] = []
    for span in ordered:
        if any(overlaps(span, a) for a in accepted):
            continue
        accepted.append(span)
    return accepted
